-- CreateTable
CREATE TABLE "TrustedPeerAgent" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "agentName" TEXT NOT NULL,
    "agentCardJson" TEXT,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "TrustedPeerAgent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TrustedPeerAgent_businessId_domain_key" ON "TrustedPeerAgent"("businessId", "domain");

-- CreateIndex
CREATE INDEX "TrustedPeerAgent_businessId_idx" ON "TrustedPeerAgent"("businessId");

-- AddForeignKey
ALTER TABLE "TrustedPeerAgent" ADD CONSTRAINT "TrustedPeerAgent_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
