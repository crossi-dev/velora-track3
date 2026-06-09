import { checkA2AApiKey } from "@/app/api/a2a/jsonrpc/_lib/handle-rpc";

/**
 * Validate an inbound X-API-Key for a specific tenant.
 *
 * Only the per-tenant derived key is accepted:
 * HMAC-SHA256(A2A_SECRET, businessId) encoded as base64url.
 * The raw A2A_SECRET fallback was removed after confirming all senders
 * call deriveA2AKey(secret, businessId).
 */
export function verifyA2AApiKeyForTenant(
  provided: string | null,
  businessId: string | null,
): boolean {
  const secret = process.env.A2A_SECRET;
  return checkA2AApiKey(provided, secret, businessId);
}
