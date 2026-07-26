import { getGeminiSupervisorModel } from "@/app/api/business-assistant/_lib/gemini-client";
import { callGemini } from "@/app/api/business-assistant/_lib/gemini-wrapper";
import { prisma } from "@/lib/prisma";
import { cloudLog } from "@/lib/cloud-logger";
import { executeOnboardingOrchestration } from "@/app/api/onboarding-orchestrator/_lib/orchestrator-executor";
import {
  SYSTEM_PROMPT,
  OnboardingTurnResultSchema,
  type ChatTurn,
  type OnboardingBusinessSpec,
  type OnboardingTurnResult,
} from "./conversation-schema";

export type { ChatRole, ChatTurn, OnboardingBusinessSpec, OnboardingTurnResult } from "./conversation-schema";

// FIX 5: dedicated error class so the route handler can distinguish parse
// failures from LLM/network errors, enabling retry without masking real
// upstream errors as 500s.
export class OnboardingParseError extends Error {
  constructor(cause: string) {
    super(`ONBOARDING_PARSE_ERROR:${cause}`);
    this.name = "OnboardingParseError";
  }
}

function safeParse(raw: string): OnboardingTurnResult {
  const clean = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(clean);
  } catch (err) {
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "ONBOARDING_CHAT_PARSE_JSON_FAILED",
      a2a_transfer: false,
      message: "onboarding-chat JSON.parse failed on Gemini output",
      data: { rawPreview: clean.slice(0, 300), error: err instanceof Error ? err.message : String(err) },
    });
    throw new OnboardingParseError("JSON_PARSE");
  }
  const validated = OnboardingTurnResultSchema.safeParse(parsed);
  if (!validated.success) {
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "ONBOARDING_CHAT_ZOD_VALIDATION_FAILED",
      a2a_transfer: false,
      message: "onboarding-chat output failed Zod validation",
      data: { rawPreview: clean.slice(0, 300), zodError: validated.error.flatten() },
    });
    throw new OnboardingParseError("ZOD_VALIDATION");
  }
  return validated.data as OnboardingTurnResult;
}

function toGeminiHistory(history: ChatTurn[]): Array<{ role: "user" | "model"; parts: Array<{ text: string }> }> {
  return history.map((turn) => ({
    role: turn.role === "assistant" ? "model" : "user",
    parts: [{ text: turn.content }],
  }));
}

const GEMINI_TIMEOUT_MS = 30_000;

// FIX 5: appended to system instruction on retry to force strictly-valid JSON
const RETRY_SYSTEM_ADDENDUM = `\n\nCRÍTICO: Tu respuesta anterior no era JSON válido. Respondé ÚNICAMENTE con el JSON exacto del schema pedido. Sin texto antes ni después. Sin markdown. Sin explicaciones.`;

async function callGeminiOnboarding(history: ChatTurn[], strictMode = false): Promise<string> {
  const model = getGeminiSupervisorModel();
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(Object.assign(new Error("Gemini timeout"), { name: "TimeoutError" })), GEMINI_TIMEOUT_MS),
  );
  const systemInstruction = strictMode ? SYSTEM_PROMPT + RETRY_SYSTEM_ADDENDUM : SYSTEM_PROMPT;
  const result = await Promise.race([
    model.generateContent({
      systemInstruction,
      contents: toGeminiHistory(history),
    }),
    timeout,
  ]);
  return result.response.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
}

export async function runOnboardingTurn(history: ChatTurn[]): Promise<OnboardingTurnResult> {
  const { text: firstText } = await callGemini(() => callGeminiOnboarding(history));
  try {
    return safeParse(firstText);
  } catch (err) {
    if (!(err instanceof OnboardingParseError)) throw err;
    // FIX 5: parse failed -- retry once with strict mode before propagating
    cloudLog({
      severity: "INFO",
      component: "System",
      action: "ONBOARDING_CHAT_RETRY_PARSE",
      a2a_transfer: false,
      message: "onboarding-chat: first parse failed, retrying with strict mode",
      data: {},
    });
    const { text: retryText } = await callGemini(() => callGeminiOnboarding(history, true));
    // If this also throws OnboardingParseError, it propagates to the route
    // handler which returns a friendly user message -- never a raw 500.
    return safeParse(retryText);
  }
}

interface FinalizeArgs {
  userId: string;
  userEmail: string | null | undefined;
  userName: string | null | undefined;
  userImage: string | null | undefined;
  spec: OnboardingBusinessSpec;
}

export async function finalizeOnboarding(args: FinalizeArgs): Promise<{ businessId: string }> {
  const { userId, userEmail, userName, userImage, spec } = args;

  // FIX 1+2: pass currency and contact/fiscal/payment fields to the orchestrator
  const result = await executeOnboardingOrchestration(userId, userEmail, userName, userImage, {
    businessName: spec.businessName,
    businessType: spec.businessType,
    openingTime: spec.openingTime,
    closingTime: spec.closingTime,
    currency: spec.currency || "ARS",
    cuit: spec.cuit ?? null,
    address: spec.address ?? null,
    phone: spec.phone ?? null,
    alias: spec.alias ?? null,
    products: spec.products.map((p) => ({ name: p.name, price: p.price, stock: p.stock })),
    customers: [],
  });

  const inserts: Promise<unknown>[] = [];

  if (spec.rules.length > 0) {
    inserts.push(
      prisma.businessRule.createMany({
        data: spec.rules.map((r) => ({
          businessId: result.businessId,
          kind: r.kind,
          trigger: r.trigger,
          message: r.message,
          active: true,
        })),
        skipDuplicates: true,
      })
    );
  }

  // Employee concept removed (0 rows in production, Stage 1 cleanup) — spec.employees
  // (if the caller still sends it) is intentionally not persisted anymore.

  if (inserts.length > 0) await Promise.all(inserts);

  return { businessId: result.businessId };
}
