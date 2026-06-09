-- ============================================================
-- RLS Tenant Isolation — Velora 2026
-- ============================================================
-- APPLY MANUALLY against prod DATABASE (DIRECT_URL):
--   npx prisma db execute --file prisma/migrations/20260520500000_rls_tenant_isolation/migration.sql --schema prisma/schema.prisma
-- OR via psql:
--   psql $DIRECT_URL -f prisma/migrations/20260520500000_rls_tenant_isolation/migration.sql
--
-- DO NOT run this against the pgbouncer (pooled) URL — DDL requires a direct connection.
--
-- What this does:
--   1. Creates a dedicated DB role `velora_tenant` with NOLOGIN and limited permissions.
--      The application connects as `velora_tenant` (or the existing role is GRANTed the
--      necessary permissions) so it cannot bypass RLS via superuser privileges.
--   2. Enables RLS on every tenant-scoped table.
--   3. Creates a policy on each table that restricts ALL operations to rows where
--      businessId = current_setting('app.current_business_id', true).
--   4. Forces RLS even for the table owner via FORCE ROW LEVEL SECURITY.
--      Without FORCE, the table owner (typically the migration role) bypasses RLS.
--
-- Tables NOT subject to RLS (system / global / non-tenant):
--   User, Account, Session, VerificationToken — NextAuth auth tables; isolation
--     is by userId (unique per user), not businessId.
--   PromptExample — global few-shot library; no businessId.
--   CronCheckpoint — singleton per job; no businessId.
--   A2aJtiSeen — nonce cache; keyed by jti (JWT ID); no businessId.
--   RateLimitBucket — keyed by arbitrary string; no businessId.
--   AiRateLimit — keyed by userId; no businessId.
--   OAuthState — ephemeral; businessId present but TTL-managed by cron.
--   SaleItem / BudgetItem — child tables without their own businessId column;
--     protected via cascade from parent Sale / Budget which ARE RLS-protected.
--
-- The policy uses `true` as PERMISSIVE — meaning multiple policies OR together.
-- Since we have exactly ONE policy per table, this is equivalent to RESTRICTIVE.
-- ============================================================

-- ── Step 1: Create the application role ──────────────────────────────────────
-- The application must connect as a role that is NOT a superuser and does NOT
-- have BYPASSRLS. If Neon already uses a non-superuser role for your DATABASE_URL,
-- skip this step and instead GRANT the necessary table permissions to that role.
--
-- Neon note: Neon roles created via the Neon console are NOT superusers by default.
-- If DATABASE_URL uses the `neondb_owner` role or similar, verify:
--   SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user;
-- Both must be FALSE for RLS to work as expected.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'velora_tenant') THEN
    CREATE ROLE velora_tenant NOLOGIN;
  END IF;
END
$$;

-- Grant table-level permissions to the application role.
-- The role needs SELECT, INSERT, UPDATE, DELETE on all tenant tables.
-- Adjust the schema name if your tables are not in 'public'.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO velora_tenant;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO velora_tenant;

-- ── Step 2: Enable RLS + policies on tenant-scoped tables ────────────────────

-- Helper: the policy expression
-- current_setting('app.current_business_id', true) returns NULL (not error)
-- when the setting is missing (the `true` = missing_ok). The ::text cast handles
-- the rare case where the setting is an empty string — comparing '' = '' would
-- wrongly allow access, but we guard via the extension which only sets it to a
-- non-empty cuid().

-- ── Business ──────────────────────────────────────────────────────────────────
-- Note: Business.id IS the tenant identifier. Policy: the row's id must match
-- the current setting. This protects reads/writes to Business itself.
ALTER TABLE "Business" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Business" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "Business";
CREATE POLICY tenant_isolation ON "Business"
  FOR ALL
  USING (
    current_setting('app.current_business_id', true) IS NOT NULL
    AND current_setting('app.current_business_id', true) <> ''
    AND "id" = current_setting('app.current_business_id', true)
  );

-- ── Employee ──────────────────────────────────────────────────────────────────
ALTER TABLE "Employee" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Employee" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "Employee";
CREATE POLICY tenant_isolation ON "Employee"
  FOR ALL
  USING (
    current_setting('app.current_business_id', true) IS NOT NULL
    AND current_setting('app.current_business_id', true) <> ''
    AND "businessId" = current_setting('app.current_business_id', true)
  );

-- ── ChatMessage ───────────────────────────────────────────────────────────────
ALTER TABLE "ChatMessage" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ChatMessage" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "ChatMessage";
CREATE POLICY tenant_isolation ON "ChatMessage"
  FOR ALL
  USING (
    current_setting('app.current_business_id', true) IS NOT NULL
    AND current_setting('app.current_business_id', true) <> ''
    AND "businessId" = current_setting('app.current_business_id', true)
  );

-- ── Product ───────────────────────────────────────────────────────────────────
ALTER TABLE "Product" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Product" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "Product";
CREATE POLICY tenant_isolation ON "Product"
  FOR ALL
  USING (
    current_setting('app.current_business_id', true) IS NOT NULL
    AND current_setting('app.current_business_id', true) <> ''
    AND "businessId" = current_setting('app.current_business_id', true)
  );

-- ── Customer ──────────────────────────────────────────────────────────────────
ALTER TABLE "Customer" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Customer" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "Customer";
CREATE POLICY tenant_isolation ON "Customer"
  FOR ALL
  USING (
    current_setting('app.current_business_id', true) IS NOT NULL
    AND current_setting('app.current_business_id', true) <> ''
    AND "businessId" = current_setting('app.current_business_id', true)
  );

-- ── Supplier ──────────────────────────────────────────────────────────────────
ALTER TABLE "Supplier" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Supplier" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "Supplier";
CREATE POLICY tenant_isolation ON "Supplier"
  FOR ALL
  USING (
    current_setting('app.current_business_id', true) IS NOT NULL
    AND current_setting('app.current_business_id', true) <> ''
    AND "businessId" = current_setting('app.current_business_id', true)
  );

-- ── Sale ──────────────────────────────────────────────────────────────────────
ALTER TABLE "Sale" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Sale" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "Sale";
CREATE POLICY tenant_isolation ON "Sale"
  FOR ALL
  USING (
    current_setting('app.current_business_id', true) IS NOT NULL
    AND current_setting('app.current_business_id', true) <> ''
    AND "businessId" = current_setting('app.current_business_id', true)
  );

-- ── CashMovement ──────────────────────────────────────────────────────────────
ALTER TABLE "CashMovement" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CashMovement" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "CashMovement";
CREATE POLICY tenant_isolation ON "CashMovement"
  FOR ALL
  USING (
    current_setting('app.current_business_id', true) IS NOT NULL
    AND current_setting('app.current_business_id', true) <> ''
    AND "businessId" = current_setting('app.current_business_id', true)
  );

-- ── StockMovement ─────────────────────────────────────────────────────────────
ALTER TABLE "StockMovement" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StockMovement" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "StockMovement";
CREATE POLICY tenant_isolation ON "StockMovement"
  FOR ALL
  USING (
    current_setting('app.current_business_id', true) IS NOT NULL
    AND current_setting('app.current_business_id', true) <> ''
    AND "businessId" = current_setting('app.current_business_id', true)
  );

-- ── Invoice ───────────────────────────────────────────────────────────────────
ALTER TABLE "Invoice" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Invoice" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "Invoice";
CREATE POLICY tenant_isolation ON "Invoice"
  FOR ALL
  USING (
    current_setting('app.current_business_id', true) IS NOT NULL
    AND current_setting('app.current_business_id', true) <> ''
    AND "businessId" = current_setting('app.current_business_id', true)
  );

-- ── PaymentIntent ─────────────────────────────────────────────────────────────
ALTER TABLE "PaymentIntent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PaymentIntent" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "PaymentIntent";
CREATE POLICY tenant_isolation ON "PaymentIntent"
  FOR ALL
  USING (
    current_setting('app.current_business_id', true) IS NOT NULL
    AND current_setting('app.current_business_id', true) <> ''
    AND "businessId" = current_setting('app.current_business_id', true)
  );

-- ── BusinessCounter ───────────────────────────────────────────────────────────
ALTER TABLE "BusinessCounter" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BusinessCounter" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "BusinessCounter";
CREATE POLICY tenant_isolation ON "BusinessCounter"
  FOR ALL
  USING (
    current_setting('app.current_business_id', true) IS NOT NULL
    AND current_setting('app.current_business_id', true) <> ''
    AND "businessId" = current_setting('app.current_business_id', true)
  );

-- ── BusinessRule ──────────────────────────────────────────────────────────────
ALTER TABLE "BusinessRule" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BusinessRule" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "BusinessRule";
CREATE POLICY tenant_isolation ON "BusinessRule"
  FOR ALL
  USING (
    current_setting('app.current_business_id', true) IS NOT NULL
    AND current_setting('app.current_business_id', true) <> ''
    AND "businessId" = current_setting('app.current_business_id', true)
  );

-- ── DelegationPolicy ──────────────────────────────────────────────────────────
ALTER TABLE "DelegationPolicy" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DelegationPolicy" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "DelegationPolicy";
CREATE POLICY tenant_isolation ON "DelegationPolicy"
  FOR ALL
  USING (
    current_setting('app.current_business_id', true) IS NOT NULL
    AND current_setting('app.current_business_id', true) <> ''
    AND "businessId" = current_setting('app.current_business_id', true)
  );

-- ── BusinessDocument ──────────────────────────────────────────────────────────
ALTER TABLE "BusinessDocument" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BusinessDocument" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "BusinessDocument";
CREATE POLICY tenant_isolation ON "BusinessDocument"
  FOR ALL
  USING (
    current_setting('app.current_business_id', true) IS NOT NULL
    AND current_setting('app.current_business_id', true) <> ''
    AND "businessId" = current_setting('app.current_business_id', true)
  );

-- ── Budget ────────────────────────────────────────────────────────────────────
ALTER TABLE "Budget" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Budget" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "Budget";
CREATE POLICY tenant_isolation ON "Budget"
  FOR ALL
  USING (
    current_setting('app.current_business_id', true) IS NOT NULL
    AND current_setting('app.current_business_id', true) <> ''
    AND "businessId" = current_setting('app.current_business_id', true)
  );

-- ── MpConnection ──────────────────────────────────────────────────────────────
ALTER TABLE "MpConnection" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MpConnection" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "MpConnection";
CREATE POLICY tenant_isolation ON "MpConnection"
  FOR ALL
  USING (
    current_setting('app.current_business_id', true) IS NOT NULL
    AND current_setting('app.current_business_id', true) <> ''
    AND "businessId" = current_setting('app.current_business_id', true)
  );

-- ── MlCredential ──────────────────────────────────────────────────────────────
ALTER TABLE "MlCredential" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MlCredential" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "MlCredential";
CREATE POLICY tenant_isolation ON "MlCredential"
  FOR ALL
  USING (
    current_setting('app.current_business_id', true) IS NOT NULL
    AND current_setting('app.current_business_id', true) <> ''
    AND "businessId" = current_setting('app.current_business_id', true)
  );

-- ── ArcaCredential ────────────────────────────────────────────────────────────
ALTER TABLE "ArcaCredential" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ArcaCredential" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "ArcaCredential";
CREATE POLICY tenant_isolation ON "ArcaCredential"
  FOR ALL
  USING (
    current_setting('app.current_business_id', true) IS NOT NULL
    AND current_setting('app.current_business_id', true) <> ''
    AND "businessId" = current_setting('app.current_business_id', true)
  );

-- ── ModoConnection ────────────────────────────────────────────────────────────
ALTER TABLE "ModoConnection" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ModoConnection" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "ModoConnection";
CREATE POLICY tenant_isolation ON "ModoConnection"
  FOR ALL
  USING (
    current_setting('app.current_business_id', true) IS NOT NULL
    AND current_setting('app.current_business_id', true) <> ''
    AND "businessId" = current_setting('app.current_business_id', true)
  );

-- ── CourierCredential ─────────────────────────────────────────────────────────
ALTER TABLE "CourierCredential" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CourierCredential" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "CourierCredential";
CREATE POLICY tenant_isolation ON "CourierCredential"
  FOR ALL
  USING (
    current_setting('app.current_business_id', true) IS NOT NULL
    AND current_setting('app.current_business_id', true) <> ''
    AND "businessId" = current_setting('app.current_business_id', true)
  );

-- ── AndreaniShipment ──────────────────────────────────────────────────────────
ALTER TABLE "AndreaniShipment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AndreaniShipment" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "AndreaniShipment";
CREATE POLICY tenant_isolation ON "AndreaniShipment"
  FOR ALL
  USING (
    current_setting('app.current_business_id', true) IS NOT NULL
    AND current_setting('app.current_business_id', true) <> ''
    AND "businessId" = current_setting('app.current_business_id', true)
  );

-- ── OcaShipment ───────────────────────────────────────────────────────────────
ALTER TABLE "OcaShipment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OcaShipment" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "OcaShipment";
CREATE POLICY tenant_isolation ON "OcaShipment"
  FOR ALL
  USING (
    current_setting('app.current_business_id', true) IS NOT NULL
    AND current_setting('app.current_business_id', true) <> ''
    AND "businessId" = current_setting('app.current_business_id', true)
  );

-- ── EmployeeNote ──────────────────────────────────────────────────────────────
ALTER TABLE "EmployeeNote" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EmployeeNote" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "EmployeeNote";
CREATE POLICY tenant_isolation ON "EmployeeNote"
  FOR ALL
  USING (
    current_setting('app.current_business_id', true) IS NOT NULL
    AND current_setting('app.current_business_id', true) <> ''
    AND "businessId" = current_setting('app.current_business_id', true)
  );

-- ── TrustedPeerAgent ──────────────────────────────────────────────────────────
ALTER TABLE "TrustedPeerAgent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TrustedPeerAgent" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "TrustedPeerAgent";
CREATE POLICY tenant_isolation ON "TrustedPeerAgent"
  FOR ALL
  USING (
    current_setting('app.current_business_id', true) IS NOT NULL
    AND current_setting('app.current_business_id', true) <> ''
    AND "businessId" = current_setting('app.current_business_id', true)
  );

-- ── AgentEventLog ─────────────────────────────────────────────────────────────
ALTER TABLE "AgentEventLog" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AgentEventLog" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "AgentEventLog";
CREATE POLICY tenant_isolation ON "AgentEventLog"
  FOR ALL
  USING (
    current_setting('app.current_business_id', true) IS NOT NULL
    AND current_setting('app.current_business_id', true) <> ''
    AND "businessId" = current_setting('app.current_business_id', true)
  );

-- ── IdempotencyRecord ─────────────────────────────────────────────────────────
ALTER TABLE "IdempotencyRecord" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "IdempotencyRecord" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "IdempotencyRecord";
CREATE POLICY tenant_isolation ON "IdempotencyRecord"
  FOR ALL
  USING (
    current_setting('app.current_business_id', true) IS NOT NULL
    AND current_setting('app.current_business_id', true) <> ''
    AND "businessId" = current_setting('app.current_business_id', true)
  );

-- ── CriticalWriteEvent ────────────────────────────────────────────────────────
ALTER TABLE "CriticalWriteEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CriticalWriteEvent" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "CriticalWriteEvent";
CREATE POLICY tenant_isolation ON "CriticalWriteEvent"
  FOR ALL
  USING (
    current_setting('app.current_business_id', true) IS NOT NULL
    AND current_setting('app.current_business_id', true) <> ''
    AND "businessId" = current_setting('app.current_business_id', true)
  );

-- ── PushSubscription ──────────────────────────────────────────────────────────
ALTER TABLE "PushSubscription" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PushSubscription" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "PushSubscription";
CREATE POLICY tenant_isolation ON "PushSubscription"
  FOR ALL
  USING (
    current_setting('app.current_business_id', true) IS NOT NULL
    AND current_setting('app.current_business_id', true) <> ''
    AND "businessId" = current_setting('app.current_business_id', true)
  );

-- ── DailySummaryPushLog ───────────────────────────────────────────────────────
ALTER TABLE "DailySummaryPushLog" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DailySummaryPushLog" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "DailySummaryPushLog";
CREATE POLICY tenant_isolation ON "DailySummaryPushLog"
  FOR ALL
  USING (
    current_setting('app.current_business_id', true) IS NOT NULL
    AND current_setting('app.current_business_id', true) <> ''
    AND "businessId" = current_setting('app.current_business_id', true)
  );

-- ── MessageFeedback ───────────────────────────────────────────────────────────
ALTER TABLE "MessageFeedback" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MessageFeedback" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "MessageFeedback";
CREATE POLICY tenant_isolation ON "MessageFeedback"
  FOR ALL
  USING (
    current_setting('app.current_business_id', true) IS NOT NULL
    AND current_setting('app.current_business_id', true) <> ''
    AND "businessId" = current_setting('app.current_business_id', true)
  );

-- ── MockPurchaseRequest ───────────────────────────────────────────────────────
ALTER TABLE "MockPurchaseRequest" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MockPurchaseRequest" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "MockPurchaseRequest";
CREATE POLICY tenant_isolation ON "MockPurchaseRequest"
  FOR ALL
  USING (
    current_setting('app.current_business_id', true) IS NOT NULL
    AND current_setting('app.current_business_id', true) <> ''
    AND "businessId" = current_setting('app.current_business_id', true)
  );

-- ── Step 3: Verify RLS is enabled ────────────────────────────────────────────
-- Run this query after applying the migration to confirm all tables have RLS:
--
-- SELECT tablename, rowsecurity, forcerowsecurity
-- FROM pg_tables
-- WHERE schemaname = 'public'
--   AND tablename IN (
--     'Business','Employee','ChatMessage','Product','Customer','Supplier',
--     'Sale','CashMovement','StockMovement','Invoice','PaymentIntent',
--     'BusinessCounter','BusinessRule','DelegationPolicy','BusinessDocument',
--     'Budget','MpConnection','MlCredential','ArcaCredential','ModoConnection',
--     'CourierCredential','AndreaniShipment','OcaShipment','EmployeeNote',
--     'TrustedPeerAgent','AgentEventLog','IdempotencyRecord','CriticalWriteEvent',
--     'PushSubscription','DailySummaryPushLog','MessageFeedback','MockPurchaseRequest'
--   )
-- ORDER BY tablename;
--
-- Expected: rowsecurity = true, forcerowsecurity = true for all rows.
--
-- ── Step 4: Verify the DB role ───────────────────────────────────────────────
-- SELECT rolname, rolsuper, rolbypassrls
-- FROM pg_roles
-- WHERE rolname = current_user;
-- Expected: rolsuper = false, rolbypassrls = false.
-- If either is true, RLS policies are silently ignored for that role.
