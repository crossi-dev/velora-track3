// Twilio webhook signature validation via the official Twilio Node.js SDK.
//
// The SDK's validateRequest uses HMAC-SHA1 with a constant-time compare
// internally, and Twilio can evolve the signing algorithm without requiring
// changes here. Using the SDK is Twilio's strongly-recommended approach for
// future-compat (audit W-2).
//
// Ref: https://www.twilio.com/docs/usage/webhooks/webhooks-security
//      https://www.twilio.com/docs/usage/tutorials/how-to-secure-your-express-app-by-validating-incoming-twilio-requests

import { validateRequest } from "twilio";

type TwilioParamValue = string | string[];

export function isValidTwilioWebhookSignature(
  authToken: string,
  signatureHeader: string | null | undefined,
  url: string,
  params: Record<string, TwilioParamValue>
): boolean {
  if (!signatureHeader) return false;

  // validateRequest accepts Record<string, string> — cast is safe because
  // Twilio status callbacks always send flat string values from form-encoded bodies.
  return validateRequest(authToken, signatureHeader, url, params as Record<string, string>);
}
