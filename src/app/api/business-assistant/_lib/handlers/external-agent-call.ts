// External A2A Agent Call — Supervisor skill handler.
//
// Invokes a trusted external peer agent on behalf of the owner.
// Steps:
//   1. isPeerTrusted(businessId, domain) — reject if unknown
//   2. discoverAgent(domain) — get AgentCard (cached 5 min)
//   3. Validate skillId is declared in agentCard.skills
//   4. Sign outbound assertion as Supervisor
//   5. POST agentCard.url (JSON-RPC message/send)
//   6. Verify response X-Agent-Assertion against peer JWKS
//   7. touchPeerUsage, return structured result
//
// Uses the existing a2a-client sendMessage for the JSON-RPC call,
// extending it with X-Agent-Assertion and skill-structured params.

import { z } from "zod";
import { isPeerTrusted, verifyAgentAssertion, touchPeerUsage } from "@/lib/a2a-trust";
import { discoverAgent } from "@/lib/a2a-discovery";
import { signAgentAssertion } from "@/lib/agent-identity";
import { cloudLog } from "@/lib/cloud-logger";
import { randomUUID } from "crypto";

// ── Input schema ──────────────────────────────────────────────────────────────

export const ExternalAgentCallSchema = z.object({
  businessId: z.string().min(1),
  domain: z.string().min(1).max(500),
  skillId: z.string().min(1).max(200),
  params: z.record(z.unknown()),
});

export type ExternalAgentCallInput = z.infer<typeof ExternalAgentCallSchema>;

// ── Result ────────────────────────────────────────────────────────────────────

export interface ExternalAgentCallSuccess {
  ok: true;
  agentName: string;
  skillId: string;
  text: string;
  data: unknown;
}

export interface ExternalAgentCallFailure {
  ok: false;
  reason: string;
}

export type ExternalAgentCallResult = ExternalAgentCallSuccess | ExternalAgentCallFailure;

// ── Timeout ───────────────────────────────────────────────────────────────────

const PEER_CALL_TIMEOUT_MS = 15_000;

// ── Handler ───────────────────────────────────────────────────────────────────

export async function callExternalAgent(
  input: ExternalAgentCallInput,
): Promise<ExternalAgentCallResult> {
  const { businessId, domain, skillId, params } = input;

  // 1. Trust check
  const trusted = await isPeerTrusted(businessId, domain);
  if (!trusted) {
    return {
      ok: false,
      reason: `Agente desconocido. Agregá "${domain}" a los peers de confianza primero.`,
    };
  }

  // 2. Discover
  const agentCard = await discoverAgent(domain);
  if (!agentCard) {
    return {
      ok: false,
      reason: `No se pudo contactar al agente en "${domain}". Verificá que esté disponible.`,
    };
  }

  // 3. Validate skill
  const skill = agentCard.skills.find((s) => s.id === skillId);
  if (!skill) {
    const available = agentCard.skills.map((s) => s.id).join(", ");
    return {
      ok: false,
      reason: `El agente "${agentCard.name}" no tiene el skill "${skillId}". Skills disponibles: ${available}.`,
    };
  }

  // 4. Sign outbound assertion
  const assertion = signAgentAssertion("supervisor", domain);

  // 5. POST JSON-RPC with structured skill params
  const body = {
    jsonrpc: "2.0",
    id: randomUUID(),
    method: "message/send",
    params: {
      skillId,
      skillParams: params,
      message: {
        kind: "message",
        messageId: randomUUID(),
        role: "user",
        parts: [
          { kind: "data", data: { skillId, ...params } },
        ],
      },
    },
  };

  cloudLog({
    severity: "INFO",
    component: "A2A",
    action: "EXTERNAL_PEER_CALL",
    a2a_transfer: true,
    message: `Calling external peer ${agentCard.name} skill=${skillId}`,
    data: { domain, skillId, businessId },
  });

  let res: Response;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PEER_CALL_TIMEOUT_MS);
    try {
      res = await fetch(agentCard.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          ...(assertion ? { "X-Agent-Assertion": assertion } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      // BUG-FIX: clearTimeout must run on both success AND error paths.
      // Previously, a network error / abort caused the timer to leak because
      // clearTimeout was only called on the happy path.
      clearTimeout(timer);
    }
  } catch (err) {
    return {
      ok: false,
      reason: `Error de red contactando a "${agentCard.name}": ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!res.ok) {
    return {
      ok: false,
      reason: `"${agentCard.name}" respondió HTTP ${res.status}.`,
    };
  }

  // 6. Verify response assertion (cross-validation)
  // SEC-N-3: when jwksUrl is present in the AgentCard, the peer explicitly
  // supports response signing. A missing or invalid assertion at that point
  // means MITM or misconfiguration — hard-reject to prevent accepting
  // attacker-crafted responses. Only warn-log when jwksUrl is absent
  // (peer does not support signing — graceful degradation acceptable).
  const responseToken = res.headers.get("X-Agent-Assertion");
  const jwksUrl = agentCard["x-agentIdentity"]?.jwksUrl;
  if (jwksUrl) {
    const valid = await verifyAgentAssertion(responseToken, domain, jwksUrl);
    if (!valid) {
      cloudLog({
        severity: "CRITICAL",
        component: "A2A",
        action: "EXTERNAL_PEER_ASSERTION_INVALID",
        a2a_transfer: false,
        message: `Response assertion verification FAILED for ${domain} — hard-rejecting (jwksUrl present, possible MITM)`,
        data: { domain, skillId },
      });
      return { ok: false, reason: "Response assertion invalid — possible MITM or key rotation required" };
    }
  }

  const json = await res.json() as { result?: unknown; error?: { code: number; message: string } };

  if (json.error) {
    return { ok: false, reason: json.error.message };
  }

  const result = json.result as {
    kind?: string;
    parts?: Array<{ kind: string; text?: string; data?: unknown }>;
  } | null;

  if (!result) {
    return { ok: false, reason: "Respuesta vacía del agente externo." };
  }

  const parts = result.parts ?? [];
  const text = parts.filter((p) => p.kind === "text").map((p) => p.text ?? "").join("\n");
  const data = parts.find((p) => p.kind === "data")?.data ?? null;

  // 7. Touch usage timestamp (fire-and-forget)
  touchPeerUsage(businessId, domain);

  return { ok: true, agentName: agentCard.name, skillId, text, data };
}
