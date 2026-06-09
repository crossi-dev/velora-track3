-- Remove fiado payment-status machinery. Velora is pay-in-full: every Sale is always status="paid".
-- Safety: update any lingering non-paid rows before dropping the column.
UPDATE "Sale" SET status = 'paid', "amountPaid" = NULL WHERE status IN ('pending', 'partial');
ALTER TABLE "Sale" DROP COLUMN IF EXISTS "amountPaid";
