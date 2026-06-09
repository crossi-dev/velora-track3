-- CreateTable
CREATE TABLE "AndreaniShipment" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "trackingNumber" TEXT NOT NULL,
    "service" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "labelPdfPath" TEXT,
    "estimatedDelivery" TIMESTAMP(3),
    "events" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AndreaniShipment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AndreaniShipment_saleId_key" ON "AndreaniShipment"("saleId");

-- CreateIndex
CREATE UNIQUE INDEX "AndreaniShipment_trackingNumber_key" ON "AndreaniShipment"("trackingNumber");

-- CreateIndex
CREATE INDEX "AndreaniShipment_businessId_idx" ON "AndreaniShipment"("businessId");

-- CreateIndex
CREATE INDEX "AndreaniShipment_trackingNumber_idx" ON "AndreaniShipment"("trackingNumber");

-- AddForeignKey
ALTER TABLE "AndreaniShipment" ADD CONSTRAINT "AndreaniShipment_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
