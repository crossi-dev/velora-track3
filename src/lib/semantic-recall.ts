import "server-only";
// Semantic recall layer over per-tenant Customers via pgvector.
//
// Pain
// resuelto: el cajero dice "le vendí a la chica de las plantas" o "el del
// pet shop de la vuelta" — el operator humano sabe a quién se
// refiere, el SQL exacto no. Embedding sobre {nombre + contexto de
// compras recientes} permite que el LLM acceda a esa intuición.
//
// Política tenant isolation: TODA query incluye `WHERE businessId = $1`
// como primer filtro. El pgvector index es global, pero el WHERE acota
// por tenant antes que el ORDER BY similarity. Defense-in-depth al
// patrón de Velora — nunca exponer datos cross-tenant.

import { prisma } from "./prisma";
import { embedQuery, isEmbeddingsEnabled, toPgVectorLiteral } from "./embeddings";

interface SemanticCustomerHit {
  id: string;
  name: string;
  similarity: number;
}

/**
 * Find customers in this tenant most semantically similar to a free-form
 * description. Returns up to `topK` hits sorted by descending cosine
 * similarity (1.0 = identical, 0 = orthogonal, -1 = opposite).
 *
 * Returns null when:
 *   - USE_EMBEDDINGS is off
 *   - the query embedding fails (Vertex error / timeout / disabled)
 *   - no customers in the tenant have embeddings yet (cold start)
 *
 * Caller should apply a similarity threshold (recommended ≥0.7) before
 * trusting the top hit. Lower scores → escalate to clarification.
 */
export async function findCustomersByDescription(args: {
  businessId: string;
  description: string;
  topK?: number;
}): Promise<SemanticCustomerHit[] | null> {
  if (!isEmbeddingsEnabled()) return null;
  const { businessId, description, topK = 5 } = args;
  if (!businessId || !description || description.trim().length < 3) return null;

  const embedded = await embedQuery(description);
  if (!embedded) return null;

  const queryVector = toPgVectorLiteral(embedded.vector);
  const limit = Math.max(1, Math.min(50, topK));

  // pgvector cosine distance: `<=>` operator. Similarity = 1 - distance.
  // Filter by tenant FIRST so the planner narrows the rowset before the
  // ANN scan. The WHERE on businessId is index-supported.
  // LIMIT bound via parameter — Postgres accepts numeric param for LIMIT.
  const rows = await prisma.$queryRaw<Array<{ id: string; name: string; distance: number }>>`
    SELECT id, name, (embedding <=> ${queryVector}::vector) AS distance
    FROM "Customer"
    WHERE "businessId" = ${businessId}
      AND embedding IS NOT NULL
    ORDER BY embedding <=> ${queryVector}::vector
    LIMIT ${limit}
  `;

  if (rows.length === 0) return null;

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    similarity: 1 - Number(r.distance),
  }));
}

/**
 * Persist an embedding for a customer. Called by the refresh cron and on
 * customer create/update. No-op if embeddings disabled.
 *
 * Uses Prisma raw query because Prisma client cannot natively SET a
 * vector column type (Unsupported). $executeRaw bypasses the type system.
 *
 * Defense-in-depth tenant guard: WHERE clause includes both id+businessId
 * so a stale customerId from another tenant cannot trigger a cross-tenant
 * write even if upstream validation leaks. Returns false if the row does
 * not match (no-op update).
 */
export async function persistCustomerEmbedding(args: {
  businessId: string;
  customerId: string;
  embedding: number[];
}): Promise<boolean> {
  const { businessId, customerId, embedding } = args;
  if (!businessId || !customerId) return false;
  if (!Array.isArray(embedding) || embedding.length === 0) return false;
  const literal = toPgVectorLiteral(embedding);
  try {
    await prisma.$executeRaw`
      UPDATE "Customer"
      SET embedding = ${literal}::vector,
          "embeddingUpdatedAt" = NOW()
      WHERE id = ${customerId}
        AND "businessId" = ${businessId}
    `;
    return true;
  } catch {
    return false;
  }
}

/**
 * Build the canonical text we embed per customer. Keep it stable — changing
 * the shape requires a full re-embed of all rows.
 */
export function buildCustomerEmbedText(customer: {
  name: string;
  email?: string | null;
  phone?: string | null;
}): string {
  const parts = [customer.name];
  if (customer.email) parts.push(`email: ${customer.email}`);
  if (customer.phone) parts.push(`tel: ${customer.phone}`);
  return parts.join(" | ");
}
