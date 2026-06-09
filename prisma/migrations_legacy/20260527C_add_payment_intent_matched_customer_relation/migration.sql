-- Add foreign key constraint for PaymentIntent.matchedCustomerId → Customer.id
-- The column already exists (added in a prior migration); this migration only
-- adds the FK constraint that Prisma requires for the @relation declaration.
-- OnDelete: SetNull so deleting a Customer does not cascade-delete PaymentIntents.

ALTER TABLE "PaymentIntent"
  ADD CONSTRAINT "PaymentIntent_matchedCustomerId_fkey"
  FOREIGN KEY ("matchedCustomerId") REFERENCES "Customer"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
