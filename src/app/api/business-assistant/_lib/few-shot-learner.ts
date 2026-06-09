import "server-only";
import { prisma } from "@/lib/prisma";
import { embedText, toPgVectorLiteral, isEmbeddingsEnabled } from "@/lib/embeddings";
import { redactInput } from "@/lib/redact-pii";

const AUTO_SAVE_CONFIDENCE_THRESHOLD = 0.80;
const DEDUP_THRESHOLD = 0.90;
const AUTO_LEARN_CAP_PER_INTENT = 30;

interface LearnParams {
  input: string;
  outputJson: string;
  intentType: string;
  agentType: "operational" | "strategic";
  confidence: number;
  requiresClarification: boolean;
}

/**
 * Guarda un par (input → outputJson) como ejemplo de few-shot si:
 * - confidence >= 0.80
 * - no requiere clarificación
 * - no existe un ejemplo demasiado similar (cosine >= 0.90)
 * - auto_learned count para ese intent < 30
 *
 * Fire-and-forget: el caller no debe await este resultado.
 */
export async function maybeSaveFewShotExample(params: LearnParams): Promise<void> {
  if (!isEmbeddingsEnabled()) return;
  if (params.confidence < AUTO_SAVE_CONFIDENCE_THRESHOLD) return;
  if (params.requiresClarification) return;

  const embedding = await embedText(params.input, { timeoutMs: 3000 });
  if (!embedding) return;

  const vectorLiteral = toPgVectorLiteral(embedding.vector);

  const duplicate = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM "PromptExample"
    WHERE
      "agentType" = ${params.agentType}
      AND embedding IS NOT NULL
      AND 1 - (embedding <=> ${vectorLiteral}::vector) >= ${DEDUP_THRESHOLD}
    LIMIT 1
  `;

  if (duplicate.length > 0) return;

  const countResult = await prisma.$queryRaw<Array<{ cnt: number }>>`
    SELECT COUNT(*)::int AS cnt FROM "PromptExample"
    WHERE "agentType" = ${params.agentType} AND "intentType" = ${params.intentType}
      AND source = 'auto_learned'
  `;
  if ((countResult[0]?.cnt ?? 0) >= AUTO_LEARN_CAP_PER_INTENT) return;

  // Redact PII before persisting to the shared PromptExample pool.
  // The raw input may contain customer names, phone numbers, or amounts;
  // storing a sanitized version prevents tenant-specific PII from leaking
  // into the cross-tenant few-shot library.
  const safeInput = redactInput(params.input, 500);

  // Scrub customer names and large monetary amounts from the output JSON.
  // Product names are catalog data (not PII) and are intentionally kept
  // so few-shot examples remain semantically useful for retrieval.
  // Regex targets: "customerName":"...", "name":"...", amounts >= 1000.
  const safeOutputJson = params.outputJson
    .replace(/"(?:customerName|customer_name|clientName|client_name)"\s*:\s*"[^"]*"/g, '"customerName":"[CLIENTE]"')
    .replace(/:\s*(\d{4,}(?:\.\d+)?)\b/g, (_match, num) =>
      Number(num) >= 1000 ? `: "[MONTO]"` : `:${num}`,
    );

  await prisma.$executeRaw`
    INSERT INTO "PromptExample" (id, "agentType", input, "outputJson", "intentType", embedding, source, "createdAt")
    VALUES (
      gen_random_uuid()::text,
      ${params.agentType},
      ${safeInput},
      ${safeOutputJson},
      ${params.intentType},
      ${vectorLiteral}::vector,
      'auto_learned',
      NOW()
    )
  `;
}
