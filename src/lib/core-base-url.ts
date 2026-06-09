/**
 * Returns the base URL of the core (somosvelora.com) for server-to-server
 * callbacks FROM agent workers BACK to the core.
 *
 * Use this (not AGENTS_BASE_URL) when an agent service needs to call a core
 * endpoint. AGENTS_BASE_URL is the core→agents direction.
 *
 * Reads VELORA_APP_URL to match the canonical env var used throughout the
 * codebase (whatsapp.ts, mp-api-helpers.ts, etc.).
 */
export function getCoreBaseUrl(): string {
  return (process.env.VELORA_APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
}
