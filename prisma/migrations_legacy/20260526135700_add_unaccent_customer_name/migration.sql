-- Enable unaccent extension for accent-insensitive customer name lookups.
-- Postgres-native feature, pre-installed on Supabase. Idempotent.
CREATE EXTENSION IF NOT EXISTS unaccent;

-- unaccent() is STABLE (not IMMUTABLE) by default because the dictionary file
-- is read at runtime, so Postgres rejects it in functional indexes. The
-- standard Postgres pattern (documented at
-- https://wiki.postgresql.org/wiki/Strip_accents_from_strings,
-- _and_use_to_compare) is to wrap unaccent in an IMMUTABLE SQL function that
-- pins the dictionary via the regdictionary cast.
CREATE OR REPLACE FUNCTION f_unaccent(text)
  RETURNS text
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  AS $$ SELECT unaccent('unaccent'::regdictionary, $1) $$;

-- Functional index allows the planner to use the index when WHERE clauses
-- match the expression f_unaccent(lower("name")).
CREATE INDEX IF NOT EXISTS customer_name_unaccent_idx
  ON "Customer" (f_unaccent(lower("name")));
