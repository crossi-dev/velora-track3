// reply-polish.ts — Route-level reply polisher for business-assistant.
//
// Pattern: Google ADK SequentialAgent "Generator → Refinement" step applied
// as a post-processing pass. Single LLM call (max_iterations = 1).
// Ref: https://google.github.io/adk-docs/agents/workflow-agents/sequential-agents/
//
// Flash client reuses the same GoogleGenAI singleton pattern as onboarding-polish.ts
// (same Vertex project + companion location).
//
// Activation: REPLY_POLISH_ENABLED=true (independent of ONBOARDING_POLISH_ENABLED).
// If Flash fails or exceeds 500 ms → returns fallbackText unchanged (fail-open).

import { GoogleGenAI } from "@google/genai";
import { SAFETY_SETTINGS } from "./gemini-client";
import { GeminiModels } from "@/lib/gemini-models";
import { cloudLog } from "@/lib/cloud-logger";

// ── Types ─────────────────────────────────────────────────────────────────────

export type ReplyKind =
  | "onboarding_ack"
  | "chip_ack"
  | "error_feedback"
  | "query_answer"
  | "confirmation_prompt"
  | "general";

export interface PolishReplyParams {
  fallbackText: string;
  kind: ReplyKind;
  intentKind: string;
  businessId?: string;
  context?: Record<string, string>;
  /** When true: skip Flash call entirely (e.g. text already warmed by LLM). */
  skipPolish?: boolean;
}

// ── Constants ─────────────────────────────────────────────────────────────────

// 500 ms: fits below the ~800 ms P99 tail for fast-path handlers so the
// polish overhead stays invisible to the user.
// Ref: https://cloud.google.com/run/docs/about-execution-environments (response SLA)
const POLISH_TIMEOUT_MS = 500;

// Machine-token prefixes that must NOT be polished — polishing would corrupt
// the structured action payload parsed by the client.
// Mirrors ACTION_CHIP_PREFIXES_ROUTE in route.ts (kept in sync manually;
// if that list grows, update here too).
const MACHINE_TOKEN_PREFIXES = [
  "enviar_link_pago|",
  "cancelar_link_pago",
  "cliente:",
  "configurar_courier:",
  "abrir_ajustes:",
  "confirm_whatsapp:",
];

// Max input length accepted for polish. Above this we return the fallback
// without calling Flash — long structured answers (tables, lists) do not
// benefit from rephrasing and risk being truncated.
const MAX_INPUT_LEN = 600;

// Output guard: reject if output is more than 2× input length OR > 400 chars.
const MAX_OUTPUT_RATIO = 2;
const MAX_OUTPUT_LEN = 400;

const SYSTEM_PROMPT =
  "Sos el asistente de Velora, una plataforma de gestión B2B. " +
  "Reformulá el siguiente mensaje con calidez rioplatense, sin emojis, " +
  "en máximo 2 oraciones. No agregues información nueva. No uses signos de " +
  "exclamación en exceso. Respondé solo el texto del mensaje, sin comillas " +
  "ni formato extra.";

// ── Singleton ─────────────────────────────────────────────────────────────────

const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT ?? "my-gcp-project";
const COMPANION_LOCATION = process.env.VERTEX_LOCATION_COMPANION ?? "southamerica-east1";

let _aiPolish: GoogleGenAI | null = null;

function getAiPolish(): GoogleGenAI {
  if (!_aiPolish) {
    const credentialsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
    const opts: ConstructorParameters<typeof GoogleGenAI>[0] = {
      vertexai: true,
      project: PROJECT_ID,
      location: COMPANION_LOCATION,
    };
    if (credentialsJson) {
      opts.googleAuthOptions = {
        credentials: JSON.parse(credentialsJson) as Record<string, unknown>,
      };
    }
    _aiPolish = new GoogleGenAI(opts);
  }
  return _aiPolish;
}

// ── Flash call ────────────────────────────────────────────────────────────────

async function callFlash(params: PolishReplyParams): Promise<string> {
  // thinkingBudget: 0 — zero thinking tokens for minimum latency on a
  // rephrasing task that requires no reasoning.
  // Ref: https://ai.google.dev/gemini-api/docs/thinking (2026-05 rev)
  const res = await getAiPolish().models.generateContent({
    model: GeminiModels.COMPANION,
    contents: [{ role: "user", parts: [{ text: params.fallbackText }] }],
    config: {
      systemInstruction: SYSTEM_PROMPT as never,
      temperature: 0.7,
      maxOutputTokens: 120,
      safetySettings: SAFETY_SETTINGS,
      thinkingConfig: { thinkingBudget: 0 },
    } as never,
  });

  const raw = res.text ?? res.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  const trimmed = raw.trim();
  return trimmed || params.fallbackText;
}

// ── Telemetry helper ──────────────────────────────────────────────────────────

type PolishAction =
  | "POLISH_HIT"
  | "POLISH_MISS_TIMEOUT"
  | "POLISH_MISS_DISABLED"
  | "POLISH_MISS_SKIP"
  | "POLISH_MISS_TOKEN"
  | "POLISH_MISS_VALIDATION";

function logPolish(
  action: PolishAction,
  params: PolishReplyParams,
  opts: { latencyMs?: number; outputLen?: number; reason: string },
): void {
  cloudLog({
    severity: action === "POLISH_HIT" ? "INFO" : "DEBUG",
    component: "System",
    action,
    a2a_transfer: false,
    message: `ReplyPolish ${action}`,
    businessId: params.businessId,
    data: {
      intentKind: params.intentKind,
      kind: params.kind,
      latencyMs: opts.latencyMs ?? 0,
      inputLen: params.fallbackText.length,
      outputLen: opts.outputLen ?? params.fallbackText.length,
      fallback: action !== "POLISH_HIT",
      reason: opts.reason,
    },
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Returns a Flash-polished version of `fallbackText`, or `fallbackText`
 * unchanged when the env flag is off, the text contains machine tokens,
 * is too long, Flash times out, or output validation fails.
 *
 * Never throws — all branches return a string.
 */
export async function polishReply(params: PolishReplyParams): Promise<string> {
  // Gate 1: feature flag
  if (process.env.REPLY_POLISH_ENABLED !== "true") {
    logPolish("POLISH_MISS_DISABLED", params, { reason: "env flag off" });
    return params.fallbackText;
  }

  // Gate 2: explicit skip (text already warm from LLM slow path)
  if (params.skipPolish) {
    logPolish("POLISH_MISS_SKIP", params, { reason: "skipPolish=true" });
    return params.fallbackText;
  }

  // Gate 3: machine token check — structured payloads must not be rephrased
  const hasMachineToken = MACHINE_TOKEN_PREFIXES.some((prefix) =>
    prefix.endsWith("|") || prefix.endsWith(":")
      ? params.fallbackText.startsWith(prefix)
      : params.fallbackText.trim() === prefix,
  );
  if (hasMachineToken) {
    logPolish("POLISH_MISS_TOKEN", params, { reason: "machine token detected" });
    return params.fallbackText;
  }

  // Gate 4: length guard
  if (params.fallbackText.length > MAX_INPUT_LEN) {
    logPolish("POLISH_MISS_VALIDATION", params, { reason: "input too long" });
    return params.fallbackText;
  }

  // Flash call with 500 ms timeout race
  const start = Date.now();
  try {
    const output = await Promise.race([
      callFlash(params),
      new Promise<string>((resolve) =>
        setTimeout(() => resolve(params.fallbackText), POLISH_TIMEOUT_MS),
      ),
    ]);

    const latencyMs = Date.now() - start;

    // Detect timeout (output === fallbackText could be legitimate, but if
    // latency >= POLISH_TIMEOUT_MS it was the timeout sentinel)
    if (latencyMs >= POLISH_TIMEOUT_MS && output === params.fallbackText) {
      logPolish("POLISH_MISS_TIMEOUT", params, { latencyMs, reason: "timeout" });
      return params.fallbackText;
    }

    // Gate 5: output validation
    const tooLong =
      output.length > MAX_OUTPUT_LEN ||
      output.length > params.fallbackText.length * MAX_OUTPUT_RATIO;
    if (tooLong) {
      logPolish("POLISH_MISS_VALIDATION", params, {
        latencyMs,
        outputLen: output.length,
        reason: "output too long",
      });
      return params.fallbackText;
    }

    logPolish("POLISH_HIT", params, {
      latencyMs,
      outputLen: output.length,
      reason: "ok",
    });
    return output;
  } catch {
    const latencyMs = Date.now() - start;
    logPolish("POLISH_MISS_TIMEOUT", params, { latencyMs, reason: "flash error" });
    return params.fallbackText;
  }
}
