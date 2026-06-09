import "server-only";
import { prisma } from "@/lib/prisma";
import { embedText, toPgVectorLiteral, isEmbeddingsEnabled } from "@/lib/embeddings";
import { cloudLog } from "@/lib/cloud-logger";
import { redactInput } from "@/lib/redact-pii";

const DEDUP_THRESHOLD = 0.90;
const FEEDBACK_CAP = 50;

// Guarda un par (userInput → assistantAnswer) como few-shot example
// cuando el usuario confirma explícitamente con 👍.
// A diferencia del auto-learner, no requiere confidence threshold —
// el humano es la señal de calidad.
export async function maybeSaveFewShotFromFeedback({
  businessId,
  userInput,
  assistantAnswer,
}: {
  businessId: string;
  userInput: string;
  assistantAnswer: string;
}): Promise<void> {
  if (!isEmbeddingsEnabled()) return;

  const embedding = await embedText(userInput, { timeoutMs: 3000 });
  if (!embedding) return;

  const vectorLiteral = toPgVectorLiteral(embedding.vector);

  const duplicate = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM "PromptExample"
    WHERE "agentType" = 'operational'
      AND embedding IS NOT NULL
      AND 1 - (embedding <=> ${vectorLiteral}::vector) >= ${DEDUP_THRESHOLD}
    LIMIT 1
  `;
  if (duplicate.length > 0) return;

  const countResult = await prisma.$queryRaw<Array<{ cnt: number }>>`
    SELECT COUNT(*)::int AS cnt FROM "PromptExample"
    WHERE source = 'feedback_confirmed'
  `;
  if ((countResult[0]?.cnt ?? 0) >= FEEDBACK_CAP) return;

  // Redact PII before persisting to the shared PromptExample pool.
  // The raw userInput may contain customer names, phone numbers, or amounts;
  // we store a sanitized version so no tenant-specific PII leaks into the
  // cross-tenant few-shot library.
  const safeInput = redactInput(userInput, 500);

  await prisma.$executeRaw`
    INSERT INTO "PromptExample" (id, "agentType", input, "outputJson", "intentType", embedding, source, "createdAt")
    VALUES (
      gen_random_uuid()::text,
      'operational',
      ${safeInput},
      ${JSON.stringify({ answer: assistantAnswer })},
      'feedback_confirmed',
      ${vectorLiteral}::vector,
      'feedback_confirmed',
      NOW()
    )
  `;

  cloudLog({
    severity: "INFO",
    component: "FewShot",
    action: "FEEDBACK_EXAMPLE_SAVED",
    a2a_transfer: false,
    message: "saved few-shot example from positive feedback",
    businessId,
    data: { userInput: redactInput(userInput) },
  });
}
