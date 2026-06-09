-- P0 Brief Discovery v1 (2026-04-29) — Velora pivot post-Discovery.
-- Reglas activas + Perímetro de delegación + Visibility por mensaje.
-- Ver: project_velora_gap_analysis_2026_04_29.md (Gaps 1, 2, 3).
--
-- Aditiva — todas las nuevas tablas/columnas tienen defaults o son nullable.
-- Safe para deploy en prod (no toca data existente).
--
-- NOTA SSE — El diff completo contra la DB de prod incluyó dos cambios extra
-- de drift que NO forman parte del P0 y FUERON OMITIDOS intencionalmente:
--   1. DROP INDEX "Customer_embedding_cosine_idx" — index pgvector aplicado
--      vía SQL raw fuera de Prisma. Decidir aparte si reintroducirlo en schema.
--   2. ALTER TABLE "Customer" ALTER COLUMN "embeddingUpdatedAt" SET DATA TYPE
--      TIMESTAMP(3) — diferencia cosmética entre el tipo declarado y el real.
-- Ambos quedan para una migration de cleanup separada si el SSE lo decide.

-- 1. ChatMessage — agregar visibility (default "public" preserva back-compat)
ALTER TABLE "ChatMessage" ADD COLUMN "visibility" TEXT NOT NULL DEFAULT 'public';

CREATE INDEX "ChatMessage_businessId_visibility_createdAt_idx"
  ON "ChatMessage"("businessId", "visibility", "createdAt");

-- 2. BusinessRule — reglas activas que el supervisor gatilla por contexto
CREATE TABLE "BusinessRule" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessRule_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "BusinessRule_businessId_active_idx"
  ON "BusinessRule"("businessId", "active");

CREATE INDEX "BusinessRule_businessId_active_kind_idx"
  ON "BusinessRule"("businessId", "active", "kind");

ALTER TABLE "BusinessRule" ADD CONSTRAINT "BusinessRule_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- 3. DelegationPolicy — perímetro que el supervisor respeta al decidir solo
CREATE TABLE "DelegationPolicy" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "maxValue" DECIMAL(65,30),
    "conditions" TEXT NOT NULL,
    "requiresOwner" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DelegationPolicy_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DelegationPolicy_businessId_active_scope_idx"
  ON "DelegationPolicy"("businessId", "active", "scope");

ALTER TABLE "DelegationPolicy" ADD CONSTRAINT "DelegationPolicy_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
