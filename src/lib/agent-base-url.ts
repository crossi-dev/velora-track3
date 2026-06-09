// agent-base-url.ts — Centralized resolver for the agents base URL.
//
// Phase A seam for agents.somosvelora.com separation (feat/agents-subdomain-p1).
// When AGENTS_BASE_URL is unset, behavior is IDENTICAL to today (falls back to
// VELORA_APP_URL). Set AGENTS_BASE_URL to redirect all agent JSON-RPC calls to
// the separate velora-agents Cloud Run service without changing prod behavior.
//
// Callers MUST import this helper instead of reading VELORA_APP_URL directly
// for any URL that targets /api/agents/*/jsonrpc.
//
// Sources:
//   https://cloud.google.com/run/docs/multiple-services (multi-service routing)
//   https://cloud.google.com/run/docs/triggering/https-request (service-to-service)

/**
 * Returns the base URL for all agent JSON-RPC calls.
 *
 * Resolution order (first defined wins):
 *   1. AGENTS_BASE_URL  — explicit agents subdomain (agents.somosvelora.com)
 *   2. VELORA_APP_URL   — current self-call behavior (somosvelora.com)
 *   3. "http://localhost:3000" — dev fallback
 *
 * When AGENTS_BASE_URL is unset, returns the same value as today.
 * Trailing slashes are stripped to allow callers to append "/api/agents/..." safely.
 *
 * Production note: VELORA_APP_URL is always set in prod (Secret Manager /
 * cloudbuild), so the localhost fallback is dev-only. This helper subsumes the
 * per-caller fallback chains that previously existed in trigger-fiscal-receipt.ts
 * and trigger-shipment-create.ts (which used VELORA_APP_URL first anyway) —
 * behavior in prod is equivalent; the chains were not restored intentionally.
 */
export function getAgentsBaseUrl(): string {
  return (
    process.env.AGENTS_BASE_URL ??
    process.env.VELORA_APP_URL ??
    "http://localhost:3000"
  ).replace(/\/$/, "");
}
