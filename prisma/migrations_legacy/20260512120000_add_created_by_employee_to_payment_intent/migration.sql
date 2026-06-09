-- AddColumn: createdByEmployeeId on PaymentIntent
-- Audit trail: which employee initiated the cobro QR. Nullable for rows
-- created by the owner directly (and pre-existing rows). Webhook reads
-- this on confirm to push a real-time notification back to the employee.
ALTER TABLE "PaymentIntent" ADD COLUMN IF NOT EXISTS "createdByEmployeeId" TEXT;
CREATE INDEX IF NOT EXISTS "PaymentIntent_businessId_createdByEmployeeId_idx"
  ON "PaymentIntent" ("businessId", "createdByEmployeeId");
