// twilio-webhook-verify.ts — Twilio webhook signature verification.
//
// Extracted from webhook/route.ts to keep the route file under the
// 300-LOC contract.
//
// Reverse-proxy URL reconstruction (canonical Twilio pattern):
// Twilio computes the HMAC using the exact URL configured in the Sandbox console
// (https://somosvelora.com/api/whatsapp/webhook). Cloud Run terminates TLS and
// forwards to Next.js, so req.url shows the internal run.app host. Validating
// against req.url always mismatches → HTTP 403.
//
// Twilio's documented solution behind a reverse proxy / SSL terminator: rebuild
// the original public URL Twilio used and pass that to validateRequest.
//
// Sources (verified HTTP 200 2026-05-28):
//   https://www.twilio.com/docs/usage/webhooks/webhooks-security
//   https://www.twilio.com/en-us/blog/developers/tutorials/building-blocks/handle-ssl-termination-twilio-node-js-helper-library
//   https://github.com/twilio/twilio-node/issues/321  (canonical case: HTTPS→HTTP proxy)

import "server-only";
import type { NextRequest } from "next/server";
import { cloudLog } from "@/lib/cloud-logger";
import { isValidTwilioWebhookSignature } from "@/lib/twilio-webhook-signature";

export function extractTwilioSignatureParams(
  rawBody: string,
): Record<string, string | string[]> {
  const params = new URLSearchParams(rawBody);
  const collected: Record<string, string | string[]> = {};

  for (const [key, value] of params) {
    const current = collected[key];
    if (current === undefined) {
      collected[key] = value;
      continue;
    }
    collected[key] = Array.isArray(current) ? [...current, value] : [current, value];
  }

  return collected;
}

export function verifyTwilioSignature(req: NextRequest, rawBody: string): boolean {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) {
    cloudLog({
      severity: "CRITICAL",
      component: "System",
      action: "TWILIO_AUTH_TOKEN_MISSING",
      a2a_transfer: false,
      message: "TWILIO_AUTH_TOKEN not set — webhook requests will be rejected until configured",
    });
    return false;
  }

  const signatureHeader = req.headers.get("x-twilio-signature");
  const publicBase = (process.env.VELORA_APP_URL ?? "https://somosvelora.com").replace(/\/$/, "");
  const publicUrl = `${publicBase}/api/whatsapp/webhook`;

  const valid = isValidTwilioWebhookSignature(
    authToken,
    signatureHeader,
    publicUrl,
    extractTwilioSignatureParams(rawBody),
  );

  if (!valid) {
    cloudLog({
      severity: "WARNING",
      component: "WhatsApp",
      action: "TWILIO_SIGNATURE_FAIL",
      a2a_transfer: false,
      message: `Twilio signature validation failed (publicUrl=${publicUrl}, internalUrl=${req.url})`,
      data: { hasSignature: !!signatureHeader, publicUrl, internalUrl: req.url },
    });
  }

  return valid;
}
