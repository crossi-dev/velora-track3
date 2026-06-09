// messaging-credential-loader.ts — loads and decrypts per-business BusinessChannelCredential rows.
//
// Security contract:
//   - Decrypted credentials MUST NOT be logged, returned to clients, or stored in memory
//     beyond the scope of a single request.
//   - The only callers should be messaging facades (sms.ts, email.ts, pedidosya.ts).
//     Never expose this module to route handlers.
//
// BYOA-only: NO global env fallback. If a business hasn't connected a provider,
// the loader returns null and the caller fails-closed with a clear "not connected" error.
// Velora is a product FOR clients — each client brings its own account.

import { prisma } from "@/lib/prisma";
import { decrypt } from "@/infrastructure/crypto/mp-token-cipher";

export type ChannelProvider = "twilio_sms" | "resend" | "pedidosya";

// ── Generic loader ───────────────────────────────────────────────────────────

interface RawCredentialRow {
  creds: Record<string, unknown>;
  environment: string;
}

/**
 * Load and decrypt credentials for a given (businessId, provider).
 * Returns null when no credential row exists — caller should fail-closed.
 * Throws if a row exists but decryption fails (tampered or wrong key).
 */
async function loadChannelCredentials(
  businessId: string,
  provider: ChannelProvider,
): Promise<RawCredentialRow | null> {
  const row = await prisma.businessChannelCredential.findUnique({
    where: { businessId_provider: { businessId, provider } },
    select: { encryptedCredentials: true, environment: true },
  });

  if (!row) return null;

  // Decrypt throws on tag-mismatch (tampered ciphertext) — propagate to caller.
  const plaintext = decrypt(row.encryptedCredentials);
  return {
    creds: JSON.parse(plaintext) as Record<string, unknown>,
    environment: row.environment,
  };
}

// ── Twilio SMS credential shape ───────────────────────────────────────────────

export interface TwilioSmsCredentials {
  accountSid: string;
  authToken: string;
  /** E.164 number used as the From address (e.g. "+15551234567"). NEVER log. */
  from: string;
}

// ── Twilio SMS loader ─────────────────────────────────────────────────────────

/**
 * Load per-business Twilio SMS credentials.
 * Returns null when not configured — caller must fail-closed.
 *
 * All three fields (accountSid, authToken, from) are required.
 * An incomplete credential row is treated as absent to prevent partial-credential failures.
 */
export async function loadTwilioSmsCredentials(
  businessId: string,
): Promise<TwilioSmsCredentials | null> {
  const raw = await loadChannelCredentials(businessId, "twilio_sms");
  if (!raw) return null;

  const c = raw.creds;
  const accountSid = typeof c.accountSid === "string" ? c.accountSid.trim() : "";
  const authToken  = typeof c.authToken  === "string" ? c.authToken.trim()  : "";
  const from       = typeof c.from       === "string" ? c.from.trim()       : "";

  // All three required — incomplete row treated as absent.
  if (!accountSid || !authToken || !from) return null;

  // NEVER log decrypted values — see security contract above.
  return { accountSid, authToken, from };
}

// ── Resend credential shape ───────────────────────────────────────────────────

export interface ResendCredentials {
  /** Resend API key (re_…). NEVER log. */
  apiKey: string;
  /** Optional per-business sender address (e.g. "Acme <noreply@acme.com>"). */
  from?: string;
}

// ── Resend loader ─────────────────────────────────────────────────────────────

/**
 * Load per-business Resend credentials.
 * Returns null when not configured — caller must fail-closed.
 *
 * apiKey is required. from is optional (caller falls back to the platform default sender).
 */
export async function loadResendCredentials(
  businessId: string,
): Promise<ResendCredentials | null> {
  const raw = await loadChannelCredentials(businessId, "resend");
  if (!raw) return null;

  const c = raw.creds;
  const apiKey = typeof c.apiKey === "string" ? c.apiKey.trim() : "";
  const from   = typeof c.from   === "string" ? c.from.trim()   : undefined;

  // apiKey is required — incomplete row treated as absent.
  if (!apiKey) return null;

  // NEVER log decrypted values — see security contract above.
  return { apiKey, from: from || undefined };
}

// ── PedidosYa credential shape ────────────────────────────────────────────────

export interface PedidosYaCredentials {
  /** PedidosYa API bearer token. NEVER log. */
  apiToken: string;
}

// ── PedidosYa loader ──────────────────────────────────────────────────────────

/**
 * Load per-business PedidosYa credentials.
 * Returns null when not configured — caller must fail-closed.
 *
 * apiToken is required. An absent or blank token is treated as not configured.
 */
export async function loadPedidosYaCredentials(
  businessId: string,
): Promise<PedidosYaCredentials | null> {
  const raw = await loadChannelCredentials(businessId, "pedidosya");
  if (!raw) return null;

  const c = raw.creds;
  const apiToken = typeof c.apiToken === "string" ? c.apiToken.trim() : "";

  // apiToken required — incomplete row treated as absent.
  if (!apiToken) return null;

  // NEVER log decrypted values — see security contract above.
  return { apiToken };
}
