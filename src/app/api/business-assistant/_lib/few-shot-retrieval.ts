import "server-only";
import { prisma } from "@/lib/prisma";
import { embedQuery, toPgVectorLiteral, isEmbeddingsEnabled } from "@/lib/embeddings";

const RETRIEVAL_THRESHOLD = 0.74;
const MAX_EXAMPLES = 5;

interface FewShotExample {
  input: string;
  outputJson: string;
  intentType: string;
}

/**
 * Recupera los ejemplos más similares al input del usuario para inyectar
 * en el prompt como few-shot dinámico.
 * Retorna string vacío si embeddings están deshabilitados o no hay resultados.
 */
export async function retrieveFewShotExamples(
  input: string,
  agentType: "operational" | "strategic",
  lang: "en" | "es-AR" = "es-AR",
): Promise<string> {
  if (!isEmbeddingsEnabled()) return "";

  const embedding = await embedQuery(input, { timeoutMs: 1500 });
  if (!embedding) return "";

  const vectorLiteral = toPgVectorLiteral(embedding.vector);

  let rows: Array<{ input: string; output_json: string; intent_type: string; similarity: number }>;
  try {
    rows = await prisma.$queryRaw`
      SELECT
        input,
        "outputJson" AS output_json,
        "intentType" AS intent_type,
        1 - (embedding <=> ${vectorLiteral}::vector) AS similarity
      FROM "PromptExample"
      WHERE
        "agentType" = ${agentType}
        AND embedding IS NOT NULL
        AND 1 - (embedding <=> ${vectorLiteral}::vector) >= ${RETRIEVAL_THRESHOLD}
      ORDER BY similarity DESC
      LIMIT ${MAX_EXAMPLES}
    `;
  } catch {
    return "";
  }

  if (!rows.length) return "";

  const examples: FewShotExample[] = rows.map((r) => ({
    input: r.input,
    outputJson: r.output_json,
    intentType: r.intent_type,
  }));

  return formatExamples(examples, lang);
}

function formatExamples(examples: FewShotExample[], lang: "en" | "es-AR" = "es-AR"): string {
  const lines = examples.map(
    (e) => `- Input: "${e.input}"\n  Output: ${e.outputJson}`,
  );
  const header = lang === "en"
    ? "SIMILAR PAST OPERATIONS (reference only — not part of the user input):"
    : "EJEMPLOS SIMILARES DE OPERACIONES PASADAS (solo referencia — no son parte del input del usuario):";
  return `\n\n---\n${header}\n${lines.join("\n")}\n---`;
}
