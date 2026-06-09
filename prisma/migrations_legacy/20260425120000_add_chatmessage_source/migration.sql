-- Add ChatMessage.source for Agent 1 vs Agent 2 (Velora Manager) distinction.
--
-- The chat thread is shared by two agents:
--   - "assistant" (default): Agent 1 - reactive (parses voice/text, answers, registers sales)
--   - "manager":             Agent 2 - proactive (low-stock, velocity nudges, weekly patterns)
--
-- The UI uses this field to render Manager bubbles distinctly ("⚡ Velora Manager · hace 3 horas").
-- The deduplication contract is unchanged - clientMessageId remains the unique key.
--
-- Backfill strategy: existing rows whose clientMessageId starts with one of the cron-written
-- patterns are retagged as "manager". The patterns are:
--   - low-stock-alert-{businessId}-{date} - daily 09:00 ART low-stock sweep
--   - planner-nudge-{businessId}-{date}   - daily L1 velocity nudges
--   - week-patterns-{businessId}-{week}   - weekly L2 day-of-week pattern insight
--
-- PREFLIGHT (run before applying in production to verify counts look sane):
--   SELECT COUNT(*) FROM "ChatMessage" WHERE "clientMessageId" LIKE 'low-stock-alert-%';
--   SELECT COUNT(*) FROM "ChatMessage" WHERE "clientMessageId" LIKE 'planner-nudge-%';
--   SELECT COUNT(*) FROM "ChatMessage" WHERE "clientMessageId" LIKE 'week-patterns-%';
-- Expected: ~(N businesses × N days since cron deploy) for the daily ones,
--           ~(N businesses × N weeks since L2 deploy) for week-patterns.
-- If counts are unexpectedly high or any non-Manager row matches, investigate before applying.

-- AlterTable
ALTER TABLE "ChatMessage" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'assistant';

-- Backfill: retag existing Manager-pattern messages.
UPDATE "ChatMessage"
SET "source" = 'manager'
WHERE "clientMessageId" LIKE 'low-stock-alert-%'
   OR "clientMessageId" LIKE 'planner-nudge-%'
   OR "clientMessageId" LIKE 'week-patterns-%';
