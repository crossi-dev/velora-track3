import "server-only";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { embedText, toPgVectorLiteral, isEmbeddingsEnabled } from "@/lib/embeddings";
import { cloudLog } from "@/lib/cloud-logger";
import { redactInput } from "@/lib/redact-pii";
import { getGeminiModel } from "./gemini-client";

// LLM02 (insecure output handling): validated against the closed set of intents
// the relabeler stores in PromptExample. Anything outside this enum is dropped.
const RELABEL_INTENTS = [
  "register_sale", "delete_product", "edit_product", "adjust_stock", "stock_load",
  "register_movement", "bulk_price_update", "create_customer", "create_supplier",
  "edit_customer", "edit_supplier", "create_product", "business_query",
  "create_purchase_request", "return_sale", "create_budget", "answer",
] as const;

const RelabelOutputSchema = z.object({
  intent: z.enum(RELABEL_INTENTS),
  confidence: z.number().finite().min(0).max(1),
});

const RELABEL_CONFIDENCE_MIN = 0.75;
const DEDUP_THRESHOLD = 0.90;
const RELABEL_CAP = 100;

// Minimal prompt — no business context needed, just intent detection
const RELABEL_SYSTEM_PROMPT = `Eres un clasificador de intents para un asistente de negocio en español argentino.
Dado el mensaje del usuario, detectá qué operación estaba pidiendo.
Responde SOLO con JSON: { "intent": "...", "answer": "ok", "confidence": 0.0-1.0 }

Intents:
register_sale, delete_product, edit_product, adjust_stock, stock_load,
register_movement, bulk_price_update, create_customer, create_supplier,
edit_customer, edit_supplier, create_product, business_query,
create_purchase_request, return_sale, create_budget, answer

Usá "answer" cuando el mensaje no corresponde a ninguna operación de negocio.`;

async function classifyIntentViaGemini(
  userInput: string,
): Promise<{ intent: string; confidence: number } | null> {
  try {
    const model = getGeminiModel();
    const chat = model.startChat({ systemInstruction: RELABEL_SYSTEM_PROMPT, history: [] });
    const result = await chat.sendMessage([{ text: userInput }]);
    const text = (result.response.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}").trim();
    const clean = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    let parsed: unknown;
    try {
      parsed = JSON.parse(clean);
    } catch {
      return null;
    }
    const validated = RelabelOutputSchema.safeParse(parsed);
    if (!validated.success) {
      cloudLog({
        severity: "WARNING", component: "FewShot", action: "RELABEL_ZOD_VALIDATION_FAILED",
        a2a_transfer: false,
        message: "relabeler output failed Zod validation — dropping",
        data: { rawPreview: clean.slice(0, 200), zodError: validated.error.flatten() },
      });
      return null;
    }
    return validated.data;
  } catch {
    return null;
  }
}

async function saveRelabeledExample(
  userInput: string,
  intent: string,
  confidence: number,
  businessId: string,
): Promise<boolean> {
  const embedding = await embedText(userInput, { timeoutMs: 3000 });
  if (!embedding) return false;

  const vectorLiteral = toPgVectorLiteral(embedding.vector);

  const [duplicate, countResult] = await Promise.all([
    prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "PromptExample"
      WHERE "agentType" = 'operational' AND embedding IS NOT NULL
        AND 1 - (embedding <=> ${vectorLiteral}::vector) >= ${DEDUP_THRESHOLD}
      LIMIT 1`,
    prisma.$queryRaw<Array<{ cnt: number }>>`
      SELECT COUNT(*)::int AS cnt FROM "PromptExample" WHERE source = 'relabeled'`,
  ]);

  if (duplicate.length > 0 || (countResult[0]?.cnt ?? 0) >= RELABEL_CAP) return false;

  // Redact PII before persisting to the shared PromptExample pool.
  // The raw userInput may contain customer names, phone numbers, or amounts;
  // storing a sanitized version prevents tenant-specific PII from leaking
  // into the cross-tenant few-shot library.
  const safeInput = redactInput(userInput, 500);

  try {
    await prisma.$executeRaw`
      INSERT INTO "PromptExample" (id, "agentType", input, "outputJson", "intentType", embedding, source, "createdAt")
      VALUES (
        gen_random_uuid()::text, 'operational', ${safeInput},
        ${JSON.stringify({ intent, answer: "relabeled", confidence })},
        ${intent}, ${vectorLiteral}::vector, 'relabeled', NOW()
      )`;
  } catch (err) {
    cloudLog({
      severity: "WARNING", component: "FewShot", action: "RELABEL_SAVE_FAILED",
      a2a_transfer: false,
      message: "Failed to insert relabeled example",
      businessId, data: { error: err instanceof Error ? err.message : String(err) },
    });
    return false;
  }

  cloudLog({
    severity: "INFO", component: "FewShot", action: "MISSED_INTENT_RELABELED",
    a2a_transfer: false,
    message: `relabeled missed intent: ${intent} (conf=${confidence.toFixed(2)})`,
    businessId, data: { userInput: redactInput(userInput), intent, confidence },
  });
  return true;
}

/**
 * Fires when a user rates a response 👎. Re-classifies the input via Gemini Flash
 * and, if a clear non-answer intent is detected with high confidence, saves it as
 * a corrected few-shot example (source='relabeled') to improve future recognition.
 *
 * Fire-and-forget: caller must not await this.
 */
export async function maybeRelabelFromNegativeFeedback({
  businessId,
  userInput,
}: {
  businessId: string;
  userInput: string;
}): Promise<void> {
  if (!isEmbeddingsEnabled() || !userInput.trim()) return;

  const classification = await classifyIntentViaGemini(userInput);
  if (!classification) return;

  const { intent, confidence } = classification;
  if (intent === "answer" || confidence < RELABEL_CONFIDENCE_MIN) return;

  await saveRelabeledExample(userInput, intent, confidence, businessId);
}

// ── Implicit correction detection (negative learning loop) ──────────────────

const IMPLICIT_CORRECTION_RES = [
  /^no[,\s]/i,
  /eso no/i,
  /no es(o)? eso/i,
  /no\s+(era|quise|quería|queria)/i,
  /me equivoqu/i,
  /te equivocaste/i,
  /no entendiste/i,
  /incorrecto/i,
  /not that/i,
];

function looksLikeImplicitCorrection(text: string): boolean {
  return IMPLICIT_CORRECTION_RES.some((re) => re.test(text.trim()));
}

/**
 * Detects implicit user corrections ("no, eso no era", "me equivoqué") in a
 * conversation turn and, if found, relabels the previous user message so the
 * model learns from the correction without requiring explicit 👎 feedback.
 *
 * Fire-and-forget: caller must not await this.
 */
export async function maybeRelabelFromConversationCorrection({
  businessId,
  currentText,
  recentHistory,
}: {
  businessId: string;
  currentText: string;
  recentHistory: Array<{ role: "user" | "assistant"; text: string }>;
}): Promise<void> {
  if (!looksLikeImplicitCorrection(currentText)) return;
  const prevUserMsg = [...recentHistory].reverse().find((m) => m.role === "user")?.text ?? "";
  if (!prevUserMsg.trim()) return;
  await maybeRelabelFromNegativeFeedback({ businessId, userInput: prevUserMsg });
}
