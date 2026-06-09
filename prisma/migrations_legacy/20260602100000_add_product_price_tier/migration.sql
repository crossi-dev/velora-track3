-- Migration: 20260602100000_add_product_price_tier
-- Adds a price-tier model for mayorista / minorista pricing.
--
-- Source (industry reference, verified HTTP 200):
--   Lightspeed Retail price books: https://x-series-support.lightspeedhq.com/hc/en-us/articles/360000051606
--   Square CatalogPricingRule: https://developer.squareup.com/reference/square/objects/CatalogPricingRule
--
-- Design:
--   ProductPriceTier — per-tenant tier definition (mayorista, minorista, vip, etc.)
--   ProductPriceTierEntry — price override per (product, tier): explicit override wins over
--                           base Product.price. Null entry = no override (use base price).
--   Customer.priceTierId — optional FK: customer belongs to a tier, gets its prices.
--
-- All DDL is ADDITIVE — no existing columns are modified or dropped.
-- Not applied to prod until explicitly run via `npx prisma db execute --file`.

-- ── ProductPriceTier ──────────────────────────────────────────────────────────

CREATE TABLE "ProductPriceTier" (
    "id"         TEXT        NOT NULL,
    "businessId" TEXT        NOT NULL,
    -- Human-readable label shown in the UI and agent prompts.
    -- Examples: 'mayorista', 'minorista', 'vip', 'distribuidor'.
    -- max 64 chars to fit in LLM context cleanly.
    "label"      VARCHAR(64) NOT NULL,
    "description" TEXT,
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductPriceTier_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ProductPriceTier_businessId_fkey"
        FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Each (businessId, label) pair must be unique — prevents duplicate tier names per tenant.
CREATE UNIQUE INDEX "ProductPriceTier_businessId_label_key"
    ON "ProductPriceTier"("businessId", "label");

CREATE INDEX "ProductPriceTier_businessId_idx"
    ON "ProductPriceTier"("businessId");

-- ── ProductPriceTierEntry ─────────────────────────────────────────────────────
-- Price override for a specific (product, tier) combination.

CREATE TABLE "ProductPriceTierEntry" (
    "id"        TEXT          NOT NULL,
    "tierId"    TEXT          NOT NULL,
    "productId" TEXT          NOT NULL,
    "price"     DECIMAL(65,30) NOT NULL,
    "createdAt" TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductPriceTierEntry_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ProductPriceTierEntry_tierId_fkey"
        FOREIGN KEY ("tierId") REFERENCES "ProductPriceTier"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ProductPriceTierEntry_productId_fkey"
        FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Each product has at most one price per tier.
CREATE UNIQUE INDEX "ProductPriceTierEntry_tierId_productId_key"
    ON "ProductPriceTierEntry"("tierId", "productId");

CREATE INDEX "ProductPriceTierEntry_tierId_idx"
    ON "ProductPriceTierEntry"("tierId");

CREATE INDEX "ProductPriceTierEntry_productId_idx"
    ON "ProductPriceTierEntry"("productId");

-- ── Customer.priceTierId (additive column) ────────────────────────────────────
-- Optional FK: null = customer pays base Product.price.
-- SET NULL on tier delete ensures no orphan references.

ALTER TABLE "Customer"
    ADD COLUMN "priceTierId" TEXT;

ALTER TABLE "Customer"
    ADD CONSTRAINT "Customer_priceTierId_fkey"
        FOREIGN KEY ("priceTierId") REFERENCES "ProductPriceTier"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Customer_priceTierId_idx"
    ON "Customer"("priceTierId");
