-- PERF-T3-4: partial index for the owner chat-history query pattern.
-- Both history queries filter source != 'manager' AND text NOT LIKE '__transient_reply__:%'.
-- The existing (businessId, visibility, createdAt) index requires in-memory filtering
-- for the source predicate, scanning all rows for the business before applying take:10.
-- This partial index limits the index to only non-manager, non-transient rows,
-- making the top-10 history fetch a pure index scan regardless of total message count.
-- CONCURRENTLY avoids locking the table in production during the build.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "ChatMessage_owner_visible_idx"
  ON "ChatMessage" ("businessId", "createdAt" DESC)
  WHERE source != 'manager' AND text NOT LIKE '__transient_reply__:%';
