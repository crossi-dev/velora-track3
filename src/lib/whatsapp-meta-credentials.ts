// whatsapp-meta-credentials.ts — Per-tenant Meta credential resolver.
//
// Separated from whatsapp-meta.ts to stay within the 300-line server/lib limit.
//
// resolveMetaCredentialsForBusiness(businessId?) looks up WabaConnection, decrypts
// the Business Integration System User token (AES-256-GCM, mp-token-cipher format,
// key: MP_TOKEN_ENCRYPTION_KEY), and falls back to the global env vars when no row
// exists, businessId is absent, or decryption fails.
//
// Security: plaintext accessToken is NEVER logged. Lives in memory only for the
// duration of the send call.
//
// Sources:
//   Meta Tech Provider BISU token model:
//     https://developers.facebook.com/documentation/business-messaging/whatsapp/access-tokens/
//   AES-256-GCM cipher: src/infrastructure/crypto/mp-token-cipher.ts

import { cloudLog } from "@/lib/cloud-logger";
import { decrypt } from "@/infrastructure/crypto/mp-token-cipher";
import { prisma } from "@/lib/prisma";

/**
 * Resolve Meta send credentials for a specific business tenant.
 *
 * - businessId provided + WabaConnection row found: decrypts BISU token from DB.
 * - businessId absent, no WabaConnection row, or error: falls back to global env
 *   (WHATSAPP_ACCESS_TOKEN + WHATSAPP_PHONE_NUMBER_ID).
 *
 * This is the primary resolver used by all outbound Meta send functions.
 */
export async function resolveMetaCredentialsForBusiness(
  businessId?: string,
): Promise<{ accessToken: string; phoneNumberId: string }> {
  if (businessId) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- WabaConnection added in migration 20260528100000; Prisma client regen blocked on Windows DLL lock in worktree.
      const conn = await (prisma as any).wabaConnection.findUnique({
        where: { businessId },
        select: { phoneNumberId: true, accessTokenCiphertext: true },
      }) as { phoneNumberId: string; accessTokenCiphertext: string } | null;

      if (conn) {
        const accessToken = decrypt(conn.accessTokenCiphertext);
        return { accessToken, phoneNumberId: conn.phoneNumberId };
      }

      // No WabaConnection for this business — fall through to global env.
      cloudLog({
        severity: "INFO",
        component: "WhatsApp",
        action: "META_CREDENTIALS_NO_WABA",
        a2a_transfer: false,
        message: `No WabaConnection for businessId — using global Meta credentials`,
        data: { businessId },
      });
    } catch (err) {
      // Decrypt failure or DB error — log and fall back rather than killing the send.
      cloudLog({
        severity: "ERROR",
        component: "WhatsApp",
        action: "META_CREDENTIALS_RESOLVE_FAILED",
        a2a_transfer: false,
        message: `Failed to resolve per-tenant Meta credentials: ${err instanceof Error ? err.message : String(err)} — falling back to global env`,
        data: { businessId },
      });
    }
  }

  // Global fallback: single-tenant deployment or tenant without WabaConnection.
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!accessToken) throw new Error("Falta configurar WHATSAPP_ACCESS_TOKEN.");
  if (!phoneNumberId) throw new Error("Falta configurar WHATSAPP_PHONE_NUMBER_ID.");
  return { accessToken, phoneNumberId };
}
