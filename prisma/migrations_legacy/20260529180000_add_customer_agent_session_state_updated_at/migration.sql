-- Migration: add_customer_agent_session_state_updated_at
--
-- Adds Customer.agentSessionStateUpdatedAt (DateTime?) — the companion column
-- to agentSessionState (added in 20260529100000). The application layer stamps
-- this at save time and uses it for the 24-hour staleness guard at load time
-- (state older than 24h is discarded so the customer starts fresh).
--
-- This column was declared in schema.prisma and referenced by the Customer
-- Agent session-state load/save path, but its migration was never authored —
-- prod load/save threw "column does not exist" until this was applied.
--
-- Nullable: pre-existing customers remain valid (null = no saved state).

ALTER TABLE "Customer" ADD COLUMN "agentSessionStateUpdatedAt" TIMESTAMP(3);
