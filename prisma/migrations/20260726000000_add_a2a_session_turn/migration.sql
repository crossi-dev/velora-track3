-- CreateTable
-- A2ASessionTurn: Postgres-backed replacement for the in-memory A2A session
-- Map (src/app/api/a2a/jsonrpc/route.ts). See the model comment in
-- prisma/schema.prisma for the full rationale.
CREATE TABLE "A2ASessionTurn" (
    "id" TEXT NOT NULL,
    "sessionKey" TEXT NOT NULL,
    "businessId" TEXT,
    "role" TEXT NOT NULL,
    "text" VARCHAR(8192) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "A2ASessionTurn_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "A2ASessionTurn_sessionKey_createdAt_idx" ON "A2ASessionTurn"("sessionKey", "createdAt");

-- CreateIndex
CREATE INDEX "A2ASessionTurn_businessId_createdAt_idx" ON "A2ASessionTurn"("businessId", "createdAt");
