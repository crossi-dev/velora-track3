// POST /api/integrations/mp/webhook — receiver de notificaciones MP.
//
// Soporta dos topics:
//   - "merchant_order": QR dinámico in-store. Verificación vía GET lookup.
//   - "payment": checkout preferences / payment links. Verificación vía
//     HMAC-SHA256 (x-signature + x-request-id) si MP_WEBHOOK_SECRET está set.
//
// El webhook viene allowlisted en middleware — no tiene cookie ni token,
// MP simplemente pega. Rate limit aplica (IP-based) para defender contra
// ataques de flood que intenten causar lookups masivos.
//
// external_reference del order = "{businessId}:{paymentIntentId}". El webhook
// parsea el businessId del prefix antes de llamar getMpAccessToken().
//
// Idempotencia: el confirm use-case usa key "mp-confirm-{paymentIntentId}" — un
// segundo webhook del mismo order es replay y no confirma dos veces.
// Idempotency key unified to mp-confirm-{paymentIntentId} across webhook + reconcile via commit cc790b2d (DI-CRIT-1).
//
// Helpers de seguridad (IP ban + HMAC) viven en _lib/webhook-security.ts.
// Token resolution → _lib/topic-token-resolver.ts
// Per-topic MP fetch + confirm → _lib/topic-handler.ts

import { NextRequest, NextResponse } from "next/server";
import { cloudLog, runWithTraceContext } from "@/lib/cloud-logger";
import { checkRateLimit, logRouteError } from "@/app/api/_lib/route-helpers";
import {
  getClientIp,
  checkIpBan,
  verifyMpSignature,
  recordMismatch,
} from "../_lib/webhook-security";
import { resolveWebhookToken } from "./_lib/topic-token-resolver";
import { handleWebhookTopic } from "./_lib/topic-handler";

// Topics MP que disparan procesamiento. Exact-match — substring permite
// spoofing con topics crafteados ("xmerchant_order_fake" pasa includes()).
const ALLOWED_TOPICS = new Set(["merchant_order", "payment"]);

// Body size guard: MP webhook payloads are <1 KB in practice; 64 KB is generous
// and prevents OOM from malicious or misconfigured oversized bodies.
// arrayBuffer() is read before req.json() so we control the byte budget.
// Ref: https://cheatsheetseries.owasp.org/cheatsheets/Input_Validation_Cheat_Sheet.html
const MP_WEBHOOK_MAX_BODY_BYTES = 64 * 1024; // 64 KB

interface WebhookPayload {
  topic?: string;
  type?: string;
  action?: string;
  data?: { id?: string | number };
  // Some MP variants put the id at root level for legacy IPN.
  id?: string | number;
  resource?: string;
}

async function handlePost(req: NextRequest): Promise<NextResponse> {
  const clientIp = getClientIp(req.headers);
  if (await checkIpBan(clientIp)) {
    return NextResponse.json({ ok: true, ignored: "ip_banned" });
  }

  // 200/60s per-IP. MP does not publish static egress IPs, so any IP could
  // legitimately forward >20 notifications/min for a high-volume merchant.
  // 200/60s accommodates burst processing; idempotency key
  // `mp-confirm-{paymentIntentId}` prevents double-confirm if duplicates slip through.
  // Returning 200 on rate-limit suppresses MP retries (non-200 triggers retry
  // loop), but a dropped-and-not-retried webhook would stall a payment — the
  // raised limit makes that scenario extremely unlikely in normal operation.
  const rateLimited = checkRateLimit(req, "mp-webhook", 200, 60);
  if (rateLimited) {
    // REG-SEC-1: increment the mismatch counter BEFORE returning early-200.
    // Without this, flood attacks never accumulate ban-worthy counts because
    // the early return bypasses the tenant mismatch path where recordMismatch
    // is normally called. Flood attackers get 200s indefinitely with no IP ban.
    recordMismatch(clientIp);
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "MP_WEBHOOK_RATE_LIMITED",
      a2a_transfer: false,
      message:
        "MP webhook rate-limit hit — returning 200 to suppress MP retries (mismatch counter incremented for IP ban tracking).",
      data: { clientIp },
    });
    return NextResponse.json({ ok: true, ignored: "rate_limited" });
  }

  // Body size guard — read raw buffer first, reject oversized requests before parsing.
  let rawBuffer: ArrayBuffer;
  try {
    rawBuffer = await req.arrayBuffer();
  } catch {
    return NextResponse.json({ ok: true, ignored: "body_read_error" });
  }
  if (rawBuffer.byteLength > MP_WEBHOOK_MAX_BODY_BYTES) {
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "MP_WEBHOOK_BODY_TOO_LARGE",
      a2a_transfer: false,
      message: `MP webhook body exceeds ${MP_WEBHOOK_MAX_BODY_BYTES} bytes — rejected`,
      data: { byteLength: rawBuffer.byteLength, clientIp },
    });
    return NextResponse.json({ ok: false, error: "body_too_large" }, { status: 413 });
  }

  let payload: WebhookPayload | null = null;
  try {
    payload = JSON.parse(new TextDecoder().decode(rawBuffer)) as WebhookPayload;
  } catch {
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "MP_WEBHOOK_INVALID_JSON",
      a2a_transfer: false,
      message: "MP webhook body no es JSON parseable",
    });
    return NextResponse.json({ ok: true, ignored: "invalid_json" });
  }

  const topic = payload?.topic ?? payload?.type ?? "";
  const idRaw = payload?.data?.id ?? payload?.id;
  const mpOrderId = idRaw != null ? String(idRaw).trim() : "";

  if (!ALLOWED_TOPICS.has(topic)) {
    return NextResponse.json({ ok: true, ignored: `topic=${topic}` });
  }
  if (!mpOrderId || mpOrderId === "0") {
    return NextResponse.json({ ok: true, ignored: "no_id" });
  }

  // MP uses the same x-signature HMAC scheme for both "payment" and
  // "merchant_order" topics. Previously merchant_order was unverified —
  // any caller who knew the URL + an order ID could trigger a confirm lookup.
  // Both topics are now verified before any downstream processing.
  const sigOk =
    topic === "payment"
      ? verifyMpSignature(req, mpOrderId)
      : verifyMpSignature(req, "", mpOrderId); // merchant_order: id goes in merchantOrderId slot

  if (!sigOk) {
    // REG-SEC-2: count sig-invalid probes toward the IP ban threshold.
    // Without this, an attacker can brute-force HMAC signatures indefinitely
    // from a single IP — signature failures never accumulated ban-worthy counts
    // because recordMismatch was only called on tenant mismatch, not sig failure.
    // Industry standard (hooklistener.com/learn/advanced-webhook-security 2026):
    // any auth failure (sig invalid, missing headers, replay) must be counted
    // against the same per-IP abuse counter to prevent enumeration attacks.
    recordMismatch(clientIp);
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "MP_WEBHOOK_SIG_INVALID",
      a2a_transfer: false,
      message: `${topic} topic signature verification failed`,
      data: { mpOrderId, topic },
    });
    return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
  }

  // Fix (CRITICAL): for "payment" topic (Checkout Pro links), the payment was
  // created under the SELLING BUSINESS's MP account. Verifying it with the
  // central token would return 404 / 403 — keeping the PaymentIntent in
  // "pending" forever. We must use the per-business token instead.
  //
  // For "merchant_order" (QR in-store), the central token is correct for now.
  //
  // Resolution strategy for "payment":
  //   1. Peek at the x-notification-url query param ?businessId= (belt-and-suspenders).
  //   2. For the MP verification call we need external_reference, which lives
  //      INSIDE the payment resource — but we can't call MP without a token first.
  //      Solution: parse businessId from ?businessId= query param appended by
  //      createMpPreference, resolve the token, call MP, then re-validate that
  //      external_reference's businessId matches.
  //   3. If ?businessId= is absent (old preference without the param), we cannot
  //      determine which business to use — treat the notification as un-verifiable.
  const businessIdFromQuery = req.nextUrl.searchParams.get("businessId") ?? null;

  try {
    const tokenResult = await resolveWebhookToken(topic, businessIdFromQuery, mpOrderId);
    if (tokenResult.kind === "early") return tokenResult.response;

    return await handleWebhookTopic({
      topic,
      mpOrderId,
      accessToken: tokenResult.accessToken,
      businessIdFromQuery,
      clientIp,
    });
  } catch (error) {
    logRouteError("integrations/mp/webhook", error);
    return NextResponse.json(
      { type: "urn:velora:internal-error", title: "Internal server error", status: 500 },
      { status: 500 },
    );
  }
}

export function POST(req: NextRequest): Promise<NextResponse> {
  return runWithTraceContext(req.headers, () => handlePost(req));
}
