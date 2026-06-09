// Sub-agent hallucination guard — catalog-based reply validation for A2A agents.
//
// Industry-standard 2026 pattern (Google ADK): each agent enforces its own
// guardrails rather than relying solely on the Supervisor layer.
// Wiesinger et al. §3.3: agents must validate LLM outputs against known
// ground-truth values from tool calls before forwarding.
// https://www.kaggle.com/whitepaper-agents
//
// Agents supported (via AgentGuardCatalog discriminated union):
//   payments  — paymentIntentId + customerName
//   logistica — trackingNumbers[] + shipmentIds[]
//   fiscal    — invoiceNumbers[] + customerCuit
//   ventas    — customerNames[] + productNames[]
//   equipo    — employeeNames[]
//
// Legacy Payments callers may pass SubAgentGuardCatalog directly (no agent discriminant).
//
// ENV: SUB_AGENT_HALLUCINATION_GUARD_MODE
//   enforce  — reject (return structured error to caller) [DEFAULT]
//   warn     — log WARNING, pass through
//   off      — disabled entirely
//
// The flag is re-evaluated per call (runtime feature flag pattern) so it can
// be toggled on Cloud Run without redeploy.

import { cloudLog } from "@/lib/cloud-logger";
import { detectActionHallucination } from "@/app/api/business-assistant/_lib/answer-hallucination-guard";
import { normalizeForMatching } from "@/lib/normalize";
import { checkLogistica } from "./sub-agent-hallucination-guard.checks";

// ── Mode resolution ──────────────────────────────────────────────────────────

type GuardMode = "enforce" | "warn" | "off";

function getGuardMode(): GuardMode {
  // Default is "enforce" — aligned with the Supervisor hallucination guard
  // (HALLUCINATION_GUARD_MODE=enforce). Having sub-agent guard default to "warn"
  // created a silent prod gap where sub-agent hallucinations passed unblocked
  // unless the env var was explicitly set. Fixed: Sup #3 safety audit 2026-05-26.
  const raw = process.env.SUB_AGENT_HALLUCINATION_GUARD_MODE ?? "enforce";
  if (raw === "enforce" || raw === "warn" || raw === "off") return raw;
  return "enforce";
}

// ── Text normalizer ──────────────────────────────────────────────────────────
// Delegates to the canonical normalizeForMatching (NFKC→NFD→\p{M}→lowercase).
// Thin wrapper that also trims — callers in this file expect trimmed output.

function normalize(s: string): string {
  return normalizeForMatching(s.trim());
}

// ── Catalog check helpers ────────────────────────────────────────────────────

/**
 * Returns true when `candidate` is a plausible mention of one of the catalog
 * values. Uses normalized prefix / substring match — intentionally liberal to
 * avoid false positives on LLM paraphrasing (e.g. "pi_abc" → "pi_abc123").
 */
function mentionMatchesCatalog(candidate: string, catalog: string[]): boolean {
  const cn = normalize(candidate);
  return catalog.some((entry) => {
    const en = normalize(entry);
    return cn === en || en.includes(cn) || cn.includes(en);
  });
}

// ── PaymentIntent ID extraction ──────────────────────────────────────────────
// Matches bare "pi_<id>" patterns in free text. Keeps false-positive risk low
// by requiring the pi_ prefix (the DB format used throughout Velora).

const PAYMENT_INTENT_ID_RE = /\bpi_[A-Za-z0-9_-]+/g;

function extractPaymentIntentMentions(text: string): string[] {
  return [...text.matchAll(PAYMENT_INTENT_ID_RE)].map((m) => m[0]);
}

// ── Public surface ───────────────────────────────────────────────────────────

export interface SubAgentGuardCatalog {
  /** paymentIntentId returned by the tool (null if no tool call happened). */
  paymentIntentId: string | null;
  /** customerName passed into the tool call (null if not provided). */
  customerName: string | null;
}

// ── Per-agent discriminated union (used by sibling checks file) ──────────────

export type AgentGuardCatalog =
  | {
      agent: "payments";
      paymentIntentId: string | null;
      customerName: string | null;
    }
  | {
      agent: "logistica";
      trackingNumbers: string[];
      shipmentIds: string[];
    }
  | {
      agent: "fiscal";
      invoiceNumbers: string[];
      customerCuit: string | null;
    }
  | {
      agent: "ventas";
      customerNames: string[];
      productNames: string[];
    }
  | {
      agent: "equipo";
      employeeNames: string[];
    };

export interface SubAgentGuardResult {
  /** true → hallucination detected */
  blocked: boolean;
  /** machine-readable reason (only set when blocked=true) */
  reason?: string;
  /** human-readable detail for logs */
  detail?: string;
  /** guard mode at the time of evaluation */
  mode: GuardMode;
}

/**
 * Applies the sub-agent hallucination guard to an agent reply.
 *
 * Accepts either:
 *  - SubAgentGuardCatalog (legacy Payments callers — no agent discriminant)
 *  - AgentGuardCatalog   (new per-agent discriminated union — dispatches to
 *    the appropriate check function in sub-agent-hallucination-guard.checks.ts)
 *
 * Sources:
 *  - Wiesinger et al. §3.3: agents must validate LLM outputs against ground truth.
 *    https://www.kaggle.com/whitepaper-agents
 *  - ADK tool-output validation: tool results are authoritative; LLM text must agree.
 *    https://google.github.io/adk-docs/tools/
 *
 * @param replyText   - Free-text portion of the ADK final response.
 * @param catalog     - Catalog values from the resolved tool call(s).
 * @param context     - businessId / agentName for structured log fields.
 */
export function applySubAgentHallucinationGuard(
  replyText: string,
  catalog: SubAgentGuardCatalog | AgentGuardCatalog,
  context: { businessId?: string | null; agentName?: string } = {},
): SubAgentGuardResult {
  const mode = getGuardMode();
  if (mode === "off") return { blocked: false, mode };
  if (!replyText) return { blocked: false, mode };

  const agentName = context.agentName ?? "SubAgent";
  let reason: string | undefined;
  let detail: string | undefined;

  // 1. Generic past-tense write-action hallucination (shared pattern battery).
  const phraseCheck = detectActionHallucination(replyText);
  if (phraseCheck.matched) {
    reason = "prohibited_phrase";
    detail = `Pattern matched: ${phraseCheck.patternName}`;
  }

  // 2. Per-agent catalog checks — dispatched by the agent discriminant.
  if (!reason) {
    if ("agent" in catalog && catalog.agent === "logistica") {
      // Logística: validate tracking numbers and shipment IDs.
      const check = checkLogistica(replyText, catalog);
      reason = check.reason;
      detail = check.detail;
    } else if (!("agent" in catalog)) {
      // Legacy SubAgentGuardCatalog path (Payments callers).
      const legacyCatalog = catalog as SubAgentGuardCatalog;

      // PaymentIntent ID hallucination check.
      if (legacyCatalog.paymentIntentId !== null) {
        const mentions = extractPaymentIntentMentions(replyText);
        const strayMention = mentions.find(
          (m) => !mentionMatchesCatalog(m, [legacyCatalog.paymentIntentId as string]),
        );
        if (strayMention) {
          reason = "hallucinated_payment_intent_id";
          detail = `Reply mentions "${strayMention}" but tool returned "${legacyCatalog.paymentIntentId}"`;
        }
      }

      // CustomerName echo check — only when a name was provided to the tool.
      if (!reason && legacyCatalog.customerName) {
        const catalogNames = [legacyCatalog.customerName];
        const nameRe = /\b([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+){1,2})\b/g;
        const nameMentions = [...replyText.matchAll(nameRe)].map((m) => m[1]);
        const strayName = nameMentions.find(
          (n) => !mentionMatchesCatalog(n, catalogNames),
        );
        if (strayName) {
          reason = "hallucinated_customer_name";
          detail = `Reply mentions "${strayName}" but tool received customerName="${legacyCatalog.customerName}"`;
        }
      }
    }
  }

  if (!reason) return { blocked: false, mode };

  // Log regardless of mode (warn or enforce both log).
  cloudLog({
    severity: "WARNING",
    component: "A2A",
    action: "SUB_AGENT_HALLUCINATION_DETECTED",
    a2a_transfer: false,
    message: `${agentName} reply failed hallucination guard — mode=${mode} reason=${reason}`,
    businessId: context.businessId ?? "",
    data: {
      agentName,
      mode,
      reason,
      detail,
      replyPreview: replyText.slice(0, 240),
    },
  });

  if (mode === "warn") return { blocked: false, mode, reason, detail };

  // enforce: caller must surface a structured error instead of the reply.
  return { blocked: true, mode, reason, detail };
}
