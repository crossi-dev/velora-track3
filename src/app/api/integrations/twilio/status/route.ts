// POST /api/integrations/twilio/status — Twilio StatusCallback receiver.
//
// Twilio sends a form-encoded POST for every MessageStatus transition:
//   queued → sending → sent → delivered (or failed/undelivered).
//
// Auth: HMAC-SHA1 signature via X-Twilio-Signature using the auth token and
// the full callback URL + sorted params. Validated with the native crypto
// implementation in lib/twilio-webhook-signature.ts (no twilio npm package needed).
//
// Twilio contract: always respond 200. Non-2xx triggers Twilio retries, which
// would flood the endpoint for transient errors. Structured logs carry the
// diagnostic detail for failed/undelivered statuses.
//
// Ref: https://www.twilio.com/docs/messaging/guides/track-outbound-message-status
//      https://www.twilio.com/docs/usage/webhooks/messaging-webhooks

import { NextRequest, NextResponse } from "next/server";
import { cloudLog } from "@/lib/cloud-logger";
import { isValidTwilioWebhookSignature } from "@/lib/twilio-webhook-signature";

// Statuses Twilio reports for outbound WhatsApp messages.
// "read" is only available on channels that support read receipts.
const TERMINAL_STATUSES = new Set(["delivered", "read", "undelivered", "failed"]);
const FAILED_STATUSES = new Set(["undelivered", "failed"]);

// Twilio sends all status params as strings. We use a plain Record so the type
// is compatible with isValidTwilioWebhookSignature (Record<string, TwilioParamValue>).
type TwilioStatusParams = Record<string, string>;

function parseFormBody(raw: string): TwilioStatusParams {
  const result: TwilioStatusParams = {};
  for (const pair of raw.split("&")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    const key = decodeURIComponent(pair.slice(0, eq).replace(/\+/g, " "));
    const val = decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, " "));
    result[key] = val;
  }
  return result;
}

async function handlePost(req: NextRequest): Promise<NextResponse> {
  const authToken = process.env.TWILIO_AUTH_TOKEN;

  if (!authToken) {
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "TWILIO_STATUS_NO_AUTH_TOKEN",
      a2a_transfer: false,
      message: "TWILIO_AUTH_TOKEN not configured — Twilio status webhook cannot validate signatures",
    });
    // Fail-closed: reject without token so the endpoint is not exploitable.
    return NextResponse.json({ error: "not_configured" }, { status: 200 });
  }

  const rawBody = await req.text();
  const params = parseFormBody(rawBody);

  // Build the canonical URL Twilio signed. Use VELORA_APP_URL so the host
  // matches what was registered in the StatusCallback param on send.
  const appUrl = (process.env.VELORA_APP_URL ?? "").replace(/\/$/, "");
  const callbackUrl = appUrl
    ? `${appUrl}/api/integrations/twilio/status`
    : req.url;

  const signature = req.headers.get("x-twilio-signature");
  const signatureValid = isValidTwilioWebhookSignature(authToken, signature, callbackUrl, params);

  if (!signatureValid) {
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "TWILIO_STATUS_SIG_INVALID",
      a2a_transfer: false,
      message: "Twilio status webhook signature validation failed — request rejected",
      data: { messageSid: params.MessageSid, to: params.To },
    });
    // Return 200 to avoid Twilio retry flood, but log the rejection.
    return NextResponse.json({ ok: true, ignored: "invalid_signature" });
  }

  const { MessageSid, MessageStatus, ErrorCode, ErrorMessage, To } = params;

  // Only log terminal statuses at elevated severity to reduce noise from
  // intermediate transitions (queued, sending, sent).
  if (!MessageStatus) {
    return NextResponse.json({ ok: true });
  }

  const isFailed = FAILED_STATUSES.has(MessageStatus);
  const isTerminal = TERMINAL_STATUSES.has(MessageStatus);

  // Redact To phone to last-4 digits to avoid logging full numbers in Cloud Logging.
  // Consistent with the send-path redaction pattern used throughout the codebase
  // (e.g., COMM_PAYMENT_LINK_SENT logs `...${phone.slice(-4)}`).
  const toRedacted = To ? `...${To.slice(-4)}` : "unknown";

  if (isFailed) {
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: MessageStatus === "failed" ? "WHATSAPP_STATUS_FAILED" : "WHATSAPP_STATUS_UNDELIVERED",
      a2a_transfer: false,
      message: `Twilio WhatsApp delivery failed: status=${MessageStatus} sid=${MessageSid ?? "unknown"} errorCode=${ErrorCode ?? "none"}`,
      data: {
        messageSid: MessageSid,
        messageStatus: MessageStatus,
        errorCode: ErrorCode,
        errorMessage: ErrorMessage,
        to: toRedacted,
      },
    });
  } else if (MessageStatus === "delivered" || MessageStatus === "read") {
    cloudLog({
      severity: "INFO",
      component: "System",
      action: MessageStatus === "read" ? "WHATSAPP_STATUS_READ" : "WHATSAPP_STATUS_DELIVERED",
      a2a_transfer: false,
      message: `Twilio WhatsApp delivery confirmed: status=${MessageStatus} sid=${MessageSid ?? "unknown"}`,
      data: { messageSid: MessageSid, messageStatus: MessageStatus, to: toRedacted },
    });
  } else if (!isTerminal) {
    // Intermediate transitions (queued/sending/sent) — debug-level only.
    cloudLog({
      severity: "INFO",
      component: "System",
      action: "WHATSAPP_STATUS_TRANSITION",
      a2a_transfer: false,
      message: `Twilio WhatsApp status transition: ${MessageStatus} sid=${MessageSid ?? "unknown"}`,
      data: { messageSid: MessageSid, messageStatus: MessageStatus, to: toRedacted },
    });
  }

  return NextResponse.json({ ok: true });
}

export function POST(req: NextRequest): Promise<NextResponse> {
  return handlePost(req);
}
