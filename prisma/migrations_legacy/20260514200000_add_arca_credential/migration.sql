-- CreateTable
-- ArcaCredential: AFIP/ARCA per-business credential for real e-invoice emission.
-- See prisma/schema.prisma for field documentation.
CREATE TABLE "ArcaCredential" (
    "id"                  TEXT NOT NULL,
    "businessId"          TEXT NOT NULL,
    "cuit"                TEXT NOT NULL,
    "puntoVenta"          INTEGER NOT NULL,
    "condicionIva"        TEXT NOT NULL,
    "certGcsPath"         TEXT NOT NULL,
    "encryptedPassphrase" TEXT NOT NULL,
    "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"           TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ArcaCredential_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ArcaCredential_businessId_key" ON "ArcaCredential"("businessId");

-- AddForeignKey
ALTER TABLE "ArcaCredential"
    ADD CONSTRAINT "ArcaCredential_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
