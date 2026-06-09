-- AlterTable: persist employee onboarding query-task completion timestamps
-- New nullable columns so existing rows are unaffected.
ALTER TABLE "Employee" ADD COLUMN "onboardingStockQueryDoneAt" TIMESTAMP(3),
ADD COLUMN "onboardingSalesQueryDoneAt" TIMESTAMP(3),
ADD COLUMN "onboardingCompletedAt" TIMESTAMP(3);
