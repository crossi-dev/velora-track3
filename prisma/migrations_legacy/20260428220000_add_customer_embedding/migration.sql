-- pgvector RAG for customer semantic recall.
--
-- Closes the "RAG weak" gap from CONTEST_MANDATORY_TECH_AUDIT.md. Allows
-- queries like "le vendí a la chica de las plantas" to resolve to the
-- correct Customer row via semantic similarity over name + recent invoice
-- items embedded with Vertex text-embedding-004 (768 dims).
--
-- Per-tenant isolation: every query MUST include a businessId filter; the
-- vector index is global by definition (pgvector ivfflat) but the
-- application layer enforces tenant boundaries on every read path.

-- Enable extension (idempotent).
CREATE EXTENSION IF NOT EXISTS vector;

-- 768-dim aligns with Vertex text-embedding-004 default dimensionality.
ALTER TABLE "Customer" ADD COLUMN "embedding" vector(768);

-- IVFFlat index — good for ≤1M rows, low memory. Re-create as HNSW if we
-- exceed that scale. lists=100 picked for typical SMB tenant size (≤10k
-- customers per business).
CREATE INDEX IF NOT EXISTS "Customer_embedding_cosine_idx"
  ON "Customer"
  USING ivfflat ("embedding" vector_cosine_ops)
  WITH (lists = 100);

-- Back-pointer for staleness tracking — when an embedding becomes stale
-- (customer renamed, recent purchase shifts context), the cron rebuilds
-- only rows where embedding_updated_at < updatedAt.
ALTER TABLE "Customer" ADD COLUMN "embeddingUpdatedAt" TIMESTAMP;
