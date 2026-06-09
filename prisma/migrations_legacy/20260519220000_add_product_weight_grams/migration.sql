-- Migration: add Product.weightGrams
-- Optional weight field (grams) for the Logística agent's package-profile tool.
-- When null, the agent falls back to a 500 g/item default and sets
-- hasRealWeightData:false so it can communicate uncertainty to the user.
--
-- DO NOT APPLY via `prisma db execute` automatically.
-- Apply manually against the production DATABASE_URL (Neon) when ready.

ALTER TABLE "Product" ADD COLUMN "weightGrams" INTEGER;
