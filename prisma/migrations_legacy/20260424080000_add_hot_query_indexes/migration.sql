-- Batch 3 / Item 1: three indexes covering hot queries flagged by the
-- Batch 3 audit. All built online; no data migration or downtime.
--
--   1. Invoice(businessId, issuedAt): dashboard invoice list sorts by
--      issuedAt desc per business every load. Previously a full scan
--      of the businessId partition then in-memory sort.
--   2. Sale(customerId): foreign key reverse lookup; unblocks future
--      customer-history views and cascade-safe deletes.
--   3. MockPurchaseRequest(supplierId): foreign key reverse lookup;
--      supplier-delete cascade checks + future supplier-history views.
--
-- Two additional indexes (Invoice businessId+customerId+status,
-- Sale businessId+status) were audited and deliberately skipped —
-- no current hot caller; revisit when the features using them ship.

-- CreateIndex
CREATE INDEX "Invoice_businessId_issuedAt_idx" ON "Invoice"("businessId", "issuedAt");

-- CreateIndex
CREATE INDEX "Sale_customerId_idx" ON "Sale"("customerId");

-- CreateIndex
CREATE INDEX "MockPurchaseRequest_supplierId_idx" ON "MockPurchaseRequest"("supplierId");
