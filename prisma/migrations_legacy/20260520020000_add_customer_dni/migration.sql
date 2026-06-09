-- Migration: add Customer.dni (optional DNI for Andreani shipments).
-- Apply manually: npx prisma db execute --file prisma/migrations/20260520020000_add_customer_dni/migration.sql
ALTER TABLE "Customer" ADD COLUMN "dni" TEXT;
