import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { checkRateLimit, logRouteError } from "@/app/api/_lib/route-helpers";
import { cloudLog, runWithTraceContext } from "@/lib/cloud-logger";
import { verifyMetaWebhookSignature } from "../_lib/meta-webhook-security";
import { resolveBusinessForInbound } from "../_lib/business-resolver";
import { enqueueWhatsappInbound } from "@/lib/cloud-tasks-enqueue";

// Webhook now ACKs in <1s (validate signature → enqueue → 200). Heavy work
// (Customer Agent + outbound reply) runs in the velora-whatsapp-inbound Cloud
// Tasks worker. This avoids Twilio/Meta's ~15s webhook timeout that previously
// caused retries and parallel agent invocations.
// Pattern source: https://www.twilio.com/en-us/blog/handle-long-running-asynchronous-operations-studio
// 15s is enough for signature verify + resolver + enqueue.
export const maxDuration = 15;

type IncomingWhatsAppMessage = {
  from: string | null;
  /** Destination number — Twilio "To" field. Null for Meta (use phoneNumberId instead). */
  to: string | null;
  text: string | null;
  type: string | null;
  messageId: string | null;
  timestamp: string | null;
  /** Meta only: the WABA phone_number_id from value.metadata — used for business routing. */
  phoneNumberId: string | null;
  raw: Record<string, unknown>;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function extractIncomingMessages(payload: unknown): IncomingWhatsAppMessage[] {
  const payloadRecord = asRecord(payload);
  if (!payloadRecord) return [];

  // ── Meta Cloud API format ──────────────────────────────────────────
  const entries = Array.isArray(payloadRecord.entry) ? payloadRecord.entry : [];
  const extracted: IncomingWhatsAppMessage[] = [];

  for (const entry of entries) {
    const entryRecord = asRecord(entry);
    const changes = entryRecord && Array.isArray(entryRecord.changes) ? entryRecord.changes : [];

    for (const change of changes) {
      const changeRecord = asRecord(change);
      const valueRecord = changeRecord ? asRecord(changeRecord.value) : null;
      const messages = valueRecord && Array.isArray(valueRecord.messages) ? valueRecord.messages : [];

      // Extract phone_number_id from value.metadata — used for multi-tenant routing.
      // Source: https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks
      const metadataRecord = valueRecord ? asRecord(valueRecord.metadata) : null;
      const phoneNumberId = metadataRecord ? asString(metadataRecord.phone_number_id) : null;

      for (const message of messages) {
        const messageRecord = asRecord(message);
        if (!messageRecord) continue;

        const textRecord = asRecord(messageRecord.text);
        extracted.push({
          from: asString(messageRecord.from),
          to: null, // Meta does not have a "to" field — use phoneNumberId
          text: asString(textRecord?.body),
          type: asString(messageRecord.type),
          messageId: asString(messageRecord.id),
          timestamp: asString(messageRecord.timestamp),
          phoneNumberId,
          raw: messageRecord,
        });
      }
    }
  }

  return extracted;
}

/**
 * Extract a single inbound message from a Twilio form-encoded body.
 * Twilio sends one message per POST. Fields: From, To, Body, MessageSid.
 * Source: https://www.twilio.com/docs/whatsapp/api/incoming-messages
 */
function extractTwilioMessage(rawBody: string): IncomingWhatsAppMessage | null {
  const params = new URLSearchParams(rawBody);
  const from = params.get("From") ?? null;
  const to = params.get("To") ?? null;
  const body = params.get("Body") ?? null;
  const sid = params.get("MessageSid") ?? null;

  // Strip "whatsapp:" prefix that Twilio adds to both From and To numbers.
  const fromE164 = from?.replace(/^whatsapp:/i, "") ?? null;
  const toE164 = to?.replace(/^whatsapp:/i, "") ?? null;

  if (!fromE164 || !body) return null; // ignore status callbacks (no From + Body)

  return {
    from: fromE164,
    to: toE164,
    text: body,
    type: "text",
    messageId: sid,
    timestamp: null,
    phoneNumberId: null, // Twilio does not expose a phoneNumberId
    raw: Object.fromEntries(params),
  };
}

function isTwilioWebhook(req: NextRequest): boolean {
  // JD H3 (2026-05-28): prefer provider-identifying signature headers over
  // content-type. Meta uses x-hub-signature-256 (HMAC-SHA256). Twilio uses
  // x-twilio-signature (HMAC-SHA1). Header presence is harder to spoof than
  // content-type alone and avoids ambiguity when a request lacks a normal
  // content-type. Falls back to content-type detection for older Twilio paths.
  if (req.headers.get("x-hub-signature-256")) return false;
  if (req.headers.get("x-twilio-signature")) return true;
  const contentType = req.headers.get("content-type") ?? "";
  return contentType.includes("application/x-www-form-urlencoded");
}

// Twilio signature verification + param extraction extracted to a sibling
// module per the 300-LOC contract. See _lib/twilio-webhook-verify.ts for the
// canonical-URL handling that fixes the Cloud Run req.url mismatch.
import { verifyTwilioSignature } from "../_lib/twilio-webhook-verify";


/**
 * Resolve businessId per inbound message + enqueue a Cloud Task for async processing.
 *
 * Per-message try/catch: errors are logged but never re-thrown so Meta/Twilio
 * always gets 200 back. Non-200 triggers exponential retry storms.
 *
 * Async-webhook pattern (Twilio + Stripe + GCP industry-standard):
 *   https://www.twilio.com/en-us/blog/handle-long-running-asynchronous-operations-studio
 *   https://stripe.com/docs/webhooks/best-practices#acknowledge-events-immediately
 *   https://cloud.google.com/run/docs/triggering/using-tasks
 *
 * The actual Customer Agent dispatch + outbound reply runs in
 * /api/internal/tasks/whatsapp-inbound, processed by the
 * velora-whatsapp-inbound Cloud Tasks queue with OIDC auth + retries.
 */
async function dispatchMessages(
  messages: IncomingWhatsAppMessage[],
  provider: "meta" | "twilio",
): Promise<void> {
  for (const msg of messages) {
    try {
      // Skip non-text messages (images, audio, stickers…) — text only for now.
      if (!msg.from || !msg.text || !msg.messageId) continue;

      const resolved = await resolveBusinessForInbound({
        provider,
        toPhoneNumberId: msg.phoneNumberId,
        toPhoneE164: msg.to,
      });

      if (!resolved) {
        cloudLog({
          severity: "WARNING",
          component: "WhatsApp",
          action: "WEBHOOK_NO_BUSINESS",
          a2a_transfer: false,
          message: "Inbound message skipped — no business resolved",
          data: { provider, from: msg.from, phoneNumberId: msg.phoneNumberId },
        });
        continue;
      }

      await enqueueWhatsappInbound({
        provider,
        businessId: resolved.businessId,
        from: msg.from,
        text: msg.text,
        messageId: msg.messageId,
      });

      cloudLog({
        severity: "INFO",
        component: "WhatsApp",
        action: "WEBHOOK_INBOUND_ENQUEUED",
        a2a_transfer: false,
        message: "Inbound wpp enqueued to velora-whatsapp-inbound",
        data: { provider, businessId: resolved.businessId, from: msg.from, messageId: msg.messageId },
      });
    } catch (err) {
      cloudLog({
        severity: "ERROR",
        component: "WhatsApp",
        action: "WEBHOOK_ENQUEUE_ERROR",
        a2a_transfer: false,
        message: `Inbound enqueue failed: ${err instanceof Error ? err.message : String(err)}`,
        data: { provider, from: msg.from ?? null, messageId: msg.messageId ?? null },
      });
      // Never throw — webhook MUST return 200 to Meta/Twilio.
    }
  }
}

async function handleGet(req: NextRequest): Promise<NextResponse> {
  // "wpp-webhook" scope with actorKey="global" and 1000/min:
  //   1. Scope isolates the webhook bucket from the shared default bucket.
  //   2. actorKey="global" avoids keying on the Cloud Run server IP — when
  //      GCLB terminates TLS, getClientIp() returns the Cloud Run egress IP
  //      (34.54.0.223) as the LAST X-Forwarded-For entry for all inbound webhook
  //      calls (Meta, Twilio, smoke harness). Without actorKey, all callers share
  //      one tiny per-IP bucket and Meta's retry storms deplete it.
  //   3. 1000/min is safe because this route is already protected by HMAC signature
  //      verification (verifyMetaWebhookSignature / verifyTwilioSignature) — only
  //      Meta or Twilio can produce a valid signature. The rate limit here is purely
  //      a DDoS backstop for the pre-signature path.
  const rateLimited = checkRateLimit(req, "wpp-webhook", 1000, 60, { actorKey: "global" });
  if (rateLimited) return rateLimited;

  const mode = req.nextUrl.searchParams.get("hub.mode");
  const token = req.nextUrl.searchParams.get("hub.verify_token");
  const challenge = req.nextUrl.searchParams.get("hub.challenge");
  const expectedToken = process.env.WHATSAPP_VERIFY_TOKEN;

  if (!expectedToken) {
    logRouteError("whatsapp:webhook", "WHATSAPP_VERIFY_TOKEN is missing");
    return new NextResponse("Configuración inválida del servidor.", { status: 500 });
  }

  // Timing-safe comparison: guards against timing-oracle attacks that could
  // allow character-by-character brute-force of WHATSAPP_VERIFY_TOKEN.
  // Length mismatch is checked first to avoid timingSafeEqual throw (requires
  // equal-length buffers). Length of expectedToken is not secret.
  // Ref: https://nodejs.org/api/crypto.html#cryptotimingsafeequala-b
  const tokenBuf = Buffer.from(token ?? "", "utf8");
  const expectedBuf = Buffer.from(expectedToken, "utf8");
  const tokenValid = tokenBuf.length === expectedBuf.length && timingSafeEqual(tokenBuf, expectedBuf);
  if (mode !== "subscribe" || !tokenValid || !challenge) {
    return new NextResponse("Prohibido.", { status: 403 });
  }

  return new NextResponse(challenge, { status: 200 });
}

async function handlePost(req: NextRequest): Promise<NextResponse> {
  // Same "wpp-webhook" scope + actorKey="global" + 1000/min as handleGet — see comment above.
  const rateLimited = checkRateLimit(req, "wpp-webhook", 1000, 60, { actorKey: "global" });
  if (rateLimited) return rateLimited;

  try {
    // ── Twilio format: application/x-www-form-urlencoded ─────────────
    if (isTwilioWebhook(req)) {
      const rawBody = await req.text();
      if (!verifyTwilioSignature(req, rawBody)) {
        return NextResponse.json({ code: "INVALID_SIGNATURE", message: "Invalid webhook signature." }, { status: 403 });
      }

      const twilioMsg = extractTwilioMessage(rawBody);
      if (twilioMsg) {
        await dispatchMessages([twilioMsg], "twilio");
      }

      // Twilio expects an empty TwiML response (or 200 with empty body).
      return new NextResponse("<Response></Response>", {
        status: 200,
        headers: { "Content-Type": "text/xml" },
      });
    }

    // ── Meta Cloud API format: application/json ──────────────────────
    const rawBody = await req.text();

    // Verify HMAC signature from Meta.
    const signature = req.headers.get("x-hub-signature-256");
    if (!verifyMetaWebhookSignature(rawBody, signature)) {
      return NextResponse.json({ code: "INVALID_SIGNATURE", message: "Invalid webhook signature." }, { status: 403 });
    }

    const payload = JSON.parse(rawBody);
    const messages = extractIncomingMessages(payload);
    await dispatchMessages(messages, "meta");
  } catch (error) {
    logRouteError("whatsapp:webhook", error);
  }

  return NextResponse.json({ received: true }, { status: 200 });
}

export function GET(req: NextRequest): Promise<NextResponse> {
  return runWithTraceContext(req.headers, () => handleGet(req));
}

export function POST(req: NextRequest): Promise<NextResponse> {
  return runWithTraceContext(req.headers, () => handlePost(req));
}
