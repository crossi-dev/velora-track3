-- Add role field to User. Default "owner" — every Google OAuth user is the business owner.
-- Employees use Employee.role instead.
ALTER TABLE "User" ADD COLUMN "role" TEXT NOT NULL DEFAULT 'owner';
