-- Migration: enable unaccent + pg_trgm for diacritic/typo-tolerant customer lookup
--
-- Sources verified 2026-05-27:
--   unaccent:  https://www.postgresql.org/docs/current/unaccent.html
--              (CREATE EXTENSION unaccent + unaccent() function documented)
--   pg_trgm:   https://www.postgresql.org/docs/current/pgtrgm.html
--              (similarity() function + % operator documented in Tables F.26/F.27)
--   Supabase:  both are standard PostgreSQL contrib modules available on all Supabase
--              tiers — enableable via CREATE EXTENSION (confirmed via Supabase community
--              and GitHub issue history; no paid-tier gate).
--
-- Apply manually against prod:
--   npx prisma db execute --file prisma/migrations/20260527230119_unaccent_pgtrgm/migration.sql

CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- IMMUTABLE wrapper required to use unaccent() in a GIN index expression.
-- The bare unaccent() function is declared VOLATILE because its dictionary can
-- be reloaded at runtime, so Postgres refuses it in functional indexes.
-- Documented pattern: wrap with a STABLE/IMMUTABLE function that pins the
-- dictionary explicitly. Source: PostgreSQL docs §F.48 (unaccent) +
-- https://www.postgresql.org/docs/current/sql-createfunction.html (IMMUTABLE).
CREATE OR REPLACE FUNCTION public.f_unaccent(text) RETURNS text AS $$
  SELECT public.unaccent('public.unaccent', $1);
$$ LANGUAGE SQL IMMUTABLE PARALLEL SAFE;

-- GIN index on f_unaccent(name) with trigram ops for fast similarity search.
-- Covers all three customer lookup call sites that previously used ILIKE.
CREATE INDEX IF NOT EXISTS idx_customer_name_unaccent_trgm
  ON "Customer" USING GIN (public.f_unaccent(name) gin_trgm_ops);
