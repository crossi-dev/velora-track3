-- Collapse cashier/manager roles to employee
UPDATE "Employee" SET "role" = 'employee' WHERE "role" IN ('cashier', 'manager');
ALTER TABLE "Employee" ALTER COLUMN "role" SET DEFAULT 'employee';
