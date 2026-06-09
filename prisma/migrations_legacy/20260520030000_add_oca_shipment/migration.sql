-- Migration: add OcaShipment table for persisting OCA shipments.
-- Apply manually: npx prisma db execute --file prisma/migrations/20260520030000_add_oca_shipment/migration.sql
CREATE TABLE "OcaShipment" (
    "id"                TEXT NOT NULL,
    "businessId"        TEXT NOT NULL,
    "saleId"            TEXT NOT NULL,
    "trackingNumber"    TEXT NOT NULL,
    "operativa"         TEXT NOT NULL,
    "service"           TEXT NOT NULL,
    "status"            TEXT NOT NULL,
    "labelUrl"          TEXT,
    "estimatedDelivery" TIMESTAMP(3),
    "events"            JSONB NOT NULL DEFAULT '[]',
    "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OcaShipment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OcaShipment_saleId_key" ON "OcaShipment"("saleId");
CREATE UNIQUE INDEX "OcaShipment_trackingNumber_key" ON "OcaShipment"("trackingNumber");
CREATE INDEX "OcaShipment_businessId_idx" ON "OcaShipment"("businessId");
CREATE INDEX "OcaShipment_trackingNumber_idx" ON "OcaShipment"("trackingNumber");

ALTER TABLE "OcaShipment" ADD CONSTRAINT "OcaShipment_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
