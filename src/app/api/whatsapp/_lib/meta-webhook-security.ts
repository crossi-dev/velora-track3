// Meta Cloud API webhook HMAC-SHA256 signature verification.
//
// Extracted from webhook/route.ts so it's a clear sibling to the Twilio
// verification path (isValidTwilioWebhookSignature in lib/twilio-webhook-signature.ts).
//
// Spec: https://developers.facebook.com/docs/graph-api/webhooks/getting-started#verification-requests
// Header: X-Hub-Signature-256: sha256=<hex>
// Body: raw UTF-8 request body, not parsed JSON.

import { createHmac } from "crypto";
import { cloudLog } from "@/lib/cloud-logger";

/**
 * Verify the HMAC-SHA256 signature from Meta's WhatsApp Cloud API.
 * Meta sends the signature in the X-Hub-Signature-256 header as "sha256=<hex>".
 * Returns false when the secret is missing, the header is absent, or the
 * computed digest does not match.
 */
export function verifyMetaWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
): boolean {
  const appSecret = process.env.WHATSAPP_APP_SECRET;
  if (!appSecret) {
    cloudLog({
      severity: "CRITICAL",
      component: "System",
      action: "WHATSAPP_APP_SECRET_MISSING",
      a2a_transfer: false,
      message:
        "WHATSAPP_APP_SECRET not set — incoming webhook requests will be rejected until configured",
    });
    return false;
  }
  if (!signatureHeader) return false;

  const providedHex = signatureHeader.startsWith("sha256=")
    ? signatureHeader.slice(7)
    : signatureHeader;

  const computedHex = createHmac("sha256", appSecret)
    .update(rawBody, "utf-8")
    .digest("hex");

  // Constant-time comparison to prevent timing attacks.
  // The digests are always the same length (64 hex chars), but guard anyway.
  if (providedHex.length !== computedHex.length) return false;
  let mismatch = 0;
  for (let i = 0; i < computedHex.length; i++) {
    mismatch |= providedHex.charCodeAt(i) ^ computedHex.charCodeAt(i);
  }
  return mismatch === 0;
}
