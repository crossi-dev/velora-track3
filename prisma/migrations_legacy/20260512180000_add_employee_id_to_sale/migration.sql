-- AddColumn: employeeId on Sale
-- Nullable — ventas creadas por el owner quedan con NULL.
-- Enables per-employee reporting queries directly from DB.
ALTER TABLE "Sale" ADD COLUMN "employeeId" TEXT;
CREATE INDEX "Sale_businessId_employeeId_idx" ON "Sale"("businessId", "employeeId");
ALTER TABLE "Sale" ADD CONSTRAINT "Sale_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;
