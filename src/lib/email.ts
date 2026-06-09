// src/lib/email.ts — Email send facade using Resend (raw fetch, no SDK).
//
// BYOA: credentials are loaded per-business from BusinessChannelCredential (DB).
// NO global env fallback — if a business hasn't connected Resend, the call fails-closed.
//
// Fail-closed: credential absent → clear "not connected" error result.
// Never throws uncaught — always returns { ok: true, id } or { ok: false, error }.
//
// Mirrors the raw-fetch + 15s timeout + structured-result pattern from
// src/lib/whatsapp-twilio.ts. No npm dependency added.
//
// Ref: https://resend.com/docs/api-reference/emails/send-email (2026)

import { cloudLog } from "@/lib/cloud-logger";
import { loadResendCredentials } from "@/infrastructure/messaging/messaging-credential-loader";

const RESEND_API_URL = "https://api.resend.com/emails";
const SEND_TIMEOUT_MS = 15_000;
const PLATFORM_DEFAULT_FROM = "Velora <notificaciones@somosvelora.com>";

export interface SendEmailParams {
  to: string;
  subject: string;
  html?: string;
  text?: string;
}

export type EmailResult =
  | { ok: true; id: string }
  | { ok: false; error: string };

/**
 * Send a transactional email via Resend using per-business credentials.
 * businessId is REQUIRED — credentials are tenant-scoped (BYOA).
 * Fails-closed with a clear error if the business hasn't connected Resend.
 * Uses per-business `from` if configured; falls back to the Velora platform sender.
 */
export async function sendEmail(
  params: SendEmailParams,
  businessId: string,
): Promise<EmailResult> {
  const creds = await loadResendCredentials(businessId);

  if (!creds) {
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "EMAIL_SEND_NO_CREDENTIALS",
      a2a_transfer: false,
      message: "Email send skipped — no Resend credentials configured for this business (fail-closed).",
      businessId,
      data: { to: params.to, subject: params.subject },
    });
    return {
      ok: false,
      error: "Email no configurado: conectá tu cuenta de Resend en Ajustes → Servicios.",
    };
  }

  // Per-business `from` takes precedence; platform default is the fallback.
  const from = creds.from ?? PLATFORM_DEFAULT_FROM;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${creds.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: params.to,
        subject: params.subject,
        ...(params.html ? { html: params.html } : {}),
        ...(params.text ? { text: params.text } : {}),
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeout);
    if (err instanceof Error && err.name === "AbortError") {
      cloudLog({
        severity: "ERROR",
        component: "System",
        action: "EMAIL_SEND_TIMEOUT",
        a2a_transfer: false,
        message: "Resend API timed out after 15s.",
        businessId,
        data: { to: params.to },
      });
      return { ok: false, error: "Email send timed out after 15 seconds." };
    }
    const errorMessage = err instanceof Error ? err.message : String(err);
    cloudLog({
      severity: "ERROR",
      component: "System",
      action: "EMAIL_SEND_FETCH_ERROR",
      a2a_transfer: false,
      message: `Resend fetch error: ${errorMessage}`,
      businessId,
      data: { to: params.to },
    });
    return { ok: false, error: `Email send failed: ${errorMessage}` };
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    cloudLog({
      severity: "ERROR",
      component: "System",
      action: "EMAIL_SEND_API_ERROR",
      a2a_transfer: false,
      message: `Resend API error: ${response.status} ${response.statusText}`,
      businessId,
      data: { status: response.status, body: body.slice(0, 500), to: params.to },
    });
    return { ok: false, error: `Resend API error ${response.status}: ${response.statusText}` };
  }

  let id: string;
  try {
    const json = await response.json() as { id?: string };
    id = json.id ?? "unknown";
  } catch {
    id = "unknown";
  }

  // Log only id + to — subject may contain PII.
  cloudLog({
    severity: "INFO",
    component: "System",
    action: "EMAIL_SEND_ACCEPTED",
    a2a_transfer: false,
    message: `Resend accepted email (id=${id})`,
    businessId,
    data: { id, to: params.to },
  });

  return { ok: true, id };
}
