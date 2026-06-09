-- Phase 1 — Employee model + PIN auth (Track 3 pivot)
-- Aditiva: agrega Employee table + 2 columnas a tablas de audit. NO toca data existente.
-- Apply: npx prisma migrate deploy (idempotente, safe en prod)

-- CreateTable
CREATE TABLE "Employee" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "pinHash" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'cashier',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Employee_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Employee_businessId_name_key" ON "Employee"("businessId", "name");

-- CreateIndex
CREATE INDEX "Employee_businessId_active_idx" ON "Employee"("businessId", "active");

-- AddForeignKey
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable: CriticalWriteEvent
ALTER TABLE "CriticalWriteEvent" ADD COLUMN "actorEmployeeId" TEXT;

-- CreateIndex
CREATE INDEX "CriticalWriteEvent_businessId_actorEmployeeId_createdAt_idx"
    ON "CriticalWriteEvent"("businessId", "actorEmployeeId", "createdAt");

-- AlterTable: AuditLog
ALTER TABLE "AuditLog" ADD COLUMN "actorEmployeeId" TEXT;

-- CreateIndex
CREATE INDEX "AuditLog_businessId_actorEmployeeId_createdAt_idx"
    ON "AuditLog"("businessId", "actorEmployeeId", "createdAt");
