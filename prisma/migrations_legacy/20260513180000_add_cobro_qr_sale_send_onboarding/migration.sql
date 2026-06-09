-- AlterTable: add cobro_qr and sale_send onboarding timestamp columns to Employee
ALTER TABLE "Employee"
  ADD COLUMN "onboardingCobroQrDoneAt" TIMESTAMP(3),
  ADD COLUMN "onboardingSaleSendDoneAt" TIMESTAMP(3);
