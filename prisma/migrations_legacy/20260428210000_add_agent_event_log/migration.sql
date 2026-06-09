-- AgentEventLog: audit del bus A2A entre Empleado y Supervisor.
-- Aditiva — no toca tablas existentes. Safe para deploy en prod.

CREATE TABLE "AgentEventLog" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "protocol" TEXT NOT NULL,
    "protocolVersion" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "actorUserId" TEXT,
    "actorEmployeeId" TEXT,
    "source" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "payloadJson" TEXT NOT NULL,
    "decisionJson" TEXT,
    "pushSent" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "AgentEventLog_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AgentEventLog_businessId_eventId_key" ON "AgentEventLog"("businessId", "eventId");
CREATE INDEX "AgentEventLog_businessId_createdAt_idx" ON "AgentEventLog"("businessId", "createdAt");
CREATE INDEX "AgentEventLog_businessId_eventType_createdAt_idx" ON "AgentEventLog"("businessId", "eventType", "createdAt");
