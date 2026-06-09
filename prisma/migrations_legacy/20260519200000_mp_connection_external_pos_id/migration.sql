-- AddColumn: MpConnection.externalPosId
-- WS1-B: per-business QR in-store routing seam.
-- Nullable — null means the business has not configured their MP POS yet.
-- Must be set (via Settings or automated provisioning) before real QR works.

ALTER TABLE "MpConnection" ADD COLUMN "externalPosId" TEXT;
