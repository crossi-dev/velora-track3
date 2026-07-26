-- Remove the "employee" (PIN-login staff) concept entirely.
-- Confirmed: 0 rows ever written to "Employee" in production. This is Stage 1
-- of the employee-removal cleanup — see prisma/schema.prisma for the
-- corresponding model/field removals.
--
-- Columns that only ever attributed an action to an employee (targetEmployeeId,
-- Sale.employeeId, CajaSession.openedByEmployeeId/closedByEmployeeId) are kept
-- as plain nullable columns (always NULL going forward) rather than dropped —
-- several shared owner/employee code paths outside this cleanup's scope
-- (Stage 2) still reference them as scalars. Only their FK relations to the
-- now-deleted "Employee" table are dropped.

-- DropForeignKey
ALTER TABLE "ChatMessage" DROP CONSTRAINT "ChatMessage_targetEmployeeId_fkey";

-- DropForeignKey
ALTER TABLE "Sale" DROP CONSTRAINT "Sale_employeeId_fkey";

-- DropForeignKey
ALTER TABLE "CajaSession" DROP CONSTRAINT "CajaSession_openedByEmployeeId_fkey";

-- DropForeignKey
ALTER TABLE "CajaSession" DROP CONSTRAINT "CajaSession_closedByEmployeeId_fkey";

-- DropForeignKey
ALTER TABLE "EmployeeNote" DROP CONSTRAINT "EmployeeNote_businessId_fkey";

-- DropForeignKey
ALTER TABLE "EmployeeNote" DROP CONSTRAINT "EmployeeNote_employeeId_fkey";

-- DropForeignKey
ALTER TABLE "Employee" DROP CONSTRAINT "Employee_businessId_fkey";

-- DropTable
DROP TABLE "EmployeeNote";

-- DropTable
DROP TABLE "Employee";

-- AlterTable
-- loginTokenVersion was exclusively used to derive/rotate the employee PIN-login
-- URL token (businessLoginToken() / rotateBusinessLoginToken() in the now-deleted
-- src/lib/employee-auth.ts). No other reader.
ALTER TABLE "Business" DROP COLUMN "loginTokenVersion";
