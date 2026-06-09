-- Fix 1: Employee session revocation counter
ALTER TABLE "Employee" ADD COLUMN "sessionVersion" INTEGER NOT NULL DEFAULT 1;

-- Fix 3: Business login token rotation counter
ALTER TABLE "Business" ADD COLUMN "loginTokenVersion" INTEGER NOT NULL DEFAULT 1;
