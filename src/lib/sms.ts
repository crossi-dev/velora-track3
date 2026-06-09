// src/lib/sms.ts — SMS send facade via Twilio Messages API (raw fetch, no SDK).
//
// BYOA: credentials are loaded per-business from BusinessChannelCredential (DB).
// NO global env fallback — if a business hasn't connected Twilio, the call fails-closed.
//
// Fail-closed: credential absent → clear "not connected" error result.
// Never throws uncaught — always returns { ok: true, sid } or { ok: false, error }.
//
// Mirrors: src/lib/whatsapp-twilio.ts (same auth, timeout, retry structure).
// normalizePhone reused from src/lib/whatsapp-meta.ts (re-exported via whatsapp.ts).
//
// Ref: https://www.twilio.com/docs/sms/api/message-resource#create-a-message-resource (2026)

import { cloudLog } from "@/lib/cloud-logger";
import { normalizePhone } from "@/lib/whatsapp";
import { loadTwilioSmsCredentials } from "@/infrastructure/messaging/messaging-credential-loader";

const TWILIO_API_BASE_URL = "https://api.twilio.com/2010-04-01";
const SEND_TIMEOUT_MS = 15_000;

export interface SendSmsParams {
  to: string;
  body: string;
}

export type SmsResult =
  | { ok: true; sid: string }
  | { ok: false; error: string };

/**
 * Send an SMS via Twilio using per-business credentials.
 * businessId is REQUIRED — credentials are tenant-scoped (BYOA).
 * Fails-closed with a clear error if the business hasn't connected Twilio.
 */
export async function sendSms(
  params: SendSmsParams,
  businessId: string,
): Promise<SmsResult> {
  const creds = await loadTwilioSmsCredentials(businessId);

  if (!creds) {
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "SMS_SEND_NO_CREDENTIALS",
      a2a_transfer: false,
      message: "SMS send skipped — no Twilio credentials configured for this business (fail-closed).",
      businessId,
      data: { to: params.to },
    });
    return {
      ok: false,
      error: "SMS no configurado: conectá tu cuenta de Twilio en Ajustes → Servicios.",
    };
  }

  let normalizedTo: string;
  try {
    normalizedTo = normalizePhone(params.to);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Invalid phone number: ${errorMessage}` };
  }

  const { accountSid, authToken, from } = creds;
  const endpoint = `${TWILIO_API_BASE_URL}/Accounts/${accountSid}/Messages.json`;
  const basicAuth = Buffer.from(`${accountSid}:${authToken}`).toString("base64");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basicAuth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        // Plain E.164 From/To — no `whatsapp:` prefix (that's the SMS/voice path).
        From: from,
        To: normalizedTo,
        Body: params.body,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeout);
    if (err instanceof Error && err.name === "AbortError") {
      cloudLog({
        severity: "ERROR",
        component: "System",
        action: "SMS_SEND_TIMEOUT",
        a2a_transfer: false,
        message: "Twilio SMS API timed out after 15s.",
        businessId,
        data: { to: normalizedTo },
      });
      return { ok: false, error: "SMS send timed out after 15 seconds." };
    }
    const errorMessage = err instanceof Error ? err.message : String(err);
    cloudLog({
      severity: "ERROR",
      component: "System",
      action: "SMS_SEND_FETCH_ERROR",
      a2a_transfer: false,
      message: `Twilio SMS fetch error: ${errorMessage}`,
      businessId,
      data: { to: normalizedTo },
    });
    return { ok: false, error: `SMS send failed: ${errorMessage}` };
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    cloudLog({
      severity: "ERROR",
      component: "System",
      action: "SMS_SEND_API_ERROR",
      a2a_transfer: false,
      message: `Twilio SMS API error: ${response.status} ${response.statusText}`,
      businessId,
      data: { status: response.status, body: body.slice(0, 500), to: normalizedTo },
    });
    return { ok: false, error: `Twilio SMS API error ${response.status}: ${response.statusText}` };
  }

  let sid: string | undefined;
  let twilioStatus: string | undefined;
  let twilioErrorCode: number | string | undefined;
  try {
    const json = await response.json() as {
      sid?: string;
      status?: string;
      error_code?: number | string | null;
    };
    sid = json.sid;
    twilioStatus = json.status;
    twilioErrorCode = json.error_code ?? undefined;
  } catch { /* non-JSON — keep undefined */ }

  cloudLog({
    severity: twilioErrorCode ? "WARNING" : "INFO",
    component: "System",
    action: "SMS_SEND_ACCEPTED",
    a2a_transfer: false,
    message: twilioErrorCode
      ? `Twilio queued SMS but reported error_code=${twilioErrorCode}`
      : `Twilio accepted SMS (sid=${sid ?? "unknown"}, status=${twilioStatus ?? "unknown"})`,
    businessId,
    data: { sid, status: twilioStatus, errorCode: twilioErrorCode, to: normalizedTo },
  });

  if (twilioErrorCode) {
    return { ok: false, error: `Twilio SMS rejected (code ${twilioErrorCode}).` };
  }

  return { ok: true, sid: sid ?? "unknown" };
}
