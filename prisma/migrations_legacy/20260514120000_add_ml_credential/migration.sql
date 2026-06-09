-- CreateTable
CREATE TABLE "MlCredential" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "mlUserId" TEXT NOT NULL,
    "accessToken" TEXT NOT NULL,
    "refreshToken" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "siteId" TEXT NOT NULL DEFAULT 'MLA',
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MlCredential_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MlCredential_businessId_key" ON "MlCredential"("businessId");

-- AddForeignKey
ALTER TABLE "MlCredential" ADD CONSTRAINT "MlCredential_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
