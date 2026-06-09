import "server-only";

import { prisma } from "./prisma";
import { embedText, embedQuery, isEmbeddingsEnabled, toPgVectorLiteral } from "./embeddings";
import type { DocumentChunk } from "./document-chunker";

const SIMILARITY_THRESHOLD = 0.75;

async function embedAndInsert(chunk: DocumentChunk, businessId: string, sourceFile: string): Promise<boolean> {
  const embedded = await embedText(chunk.text);
  if (!embedded) return false;
  const id = crypto.randomUUID();
  const vector = toPgVectorLiteral(embedded.vector);
  await prisma.$executeRaw`
    INSERT INTO "BusinessDocument" (id, "businessId", "sourceFile", "sourcePage", "chunkIndex", "chunkText", embedding, "createdAt")
    VALUES (${id}, ${businessId}, ${sourceFile}, ${chunk.sourcePage}, ${chunk.chunkIndex}, ${chunk.text}, ${vector}::vector, NOW())
  `;
  return true;
}

export async function ingestBusinessDocument(args: {
  businessId: string;
  sourceFile: string;
  chunks: DocumentChunk[];
}): Promise<{ stored: number }> {
  const { businessId, sourceFile, chunks } = args;
  if (!isEmbeddingsEnabled()) return { stored: 0 };

  await prisma.$executeRaw`
    DELETE FROM "BusinessDocument"
    WHERE "businessId" = ${businessId} AND "sourceFile" = ${sourceFile}
  `;

  const CONCURRENCY = 5;
  let stored = 0;
  for (let i = 0; i < chunks.length; i += CONCURRENCY) {
    const batch = chunks.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map((chunk) => embedAndInsert(chunk, businessId, sourceFile)));
    stored += results.filter(Boolean).length;
  }

  return { stored };
}

export async function recallBusinessRules(args: {
  businessId: string;
  query: string;
  topK?: number;
}): Promise<string> {
  const { businessId, query, topK = 3 } = args;
  if (!isEmbeddingsEnabled()) return "";
  if (!businessId || !query.trim()) return "";

  const hasDocuments = await prisma.$queryRaw<[{ count: bigint }]>`
    SELECT COUNT(*)::bigint AS count FROM "BusinessDocument" WHERE "businessId" = ${businessId} LIMIT 1
  `;
  if (!hasDocuments[0] || hasDocuments[0].count === BigInt(0)) return "";

  const embedded = await embedQuery(query);
  if (!embedded) return "";

  const queryVector = toPgVectorLiteral(embedded.vector);
  const limit = Math.max(1, Math.min(10, topK));

  const rows = await prisma.$queryRaw<Array<{
    chunkText: string;
    sourceFile: string;
    sourcePage: number;
    distance: number;
  }>>`
    SELECT "chunkText", "sourceFile", "sourcePage",
           (embedding <=> ${queryVector}::vector) AS distance
    FROM "BusinessDocument"
    WHERE "businessId" = ${businessId}
      AND embedding IS NOT NULL
    ORDER BY embedding <=> ${queryVector}::vector
    LIMIT ${limit}
  `;

  const relevant = rows
    .map((r) => ({ ...r, similarity: 1 - Number(r.distance) }))
    .filter((r) => r.similarity >= SIMILARITY_THRESHOLD);

  if (relevant.length === 0) return "";

  return relevant
    .map((r) => `[${r.sourceFile}, p.${r.sourcePage}]: ${r.chunkText}`)
    .join("\n\n");
}
