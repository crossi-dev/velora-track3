-- DropForeignKey
ALTER TABLE "BusinessCounter" DROP CONSTRAINT "BusinessCounter_businessId_fkey";

-- AddForeignKey
ALTER TABLE "BusinessCounter" ADD CONSTRAINT "BusinessCounter_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
