import { cloudLog } from "@/lib/cloud-logger";
import { normalizePhone } from "@/lib/whatsapp-meta";

const TWILIO_API_BASE_URL = "https://api.twilio.com/2010-04-01";
const SEND_TIMEOUT_MS = 15_000;

// IIFE module-load check: log ERROR once (not per-send) when VELORA_APP_URL is
// missing in production so delivery tracking is disabled. Downgraded from per-send
// WARNING to a one-time module-load ERROR so logs are not flooded on every message send.
// Ref: 12-factor App §III — fail loud on missing config at startup, not per-request.
if (process.env.NODE_ENV === "production" && !process.env.VELORA_APP_URL) {
  cloudLog({
    severity: "ERROR",
    component: "System",
    action: "TWILIO_STATUS_CALLBACK_MISCONFIG",
    a2a_transfer: false,
    message: "VELORA_APP_URL is unset in production — Twilio StatusCallback will be omitted for all sends. Delivery tracking is disabled.",
  });
}

function createWhatsAppError(message: string) {
  return new Error(message);
}

/**
 * Send a WhatsApp message via Twilio.
 *
 * @param contentSid  Optional Twilio Content API SID for template messages.
 *                    When provided, the `text` body is ignored and Twilio sends
 *                    the pre-approved template with the given variables.
 *                    Ref: https://www.twilio.com/docs/content/send-messages-with-content-api (2026)
 * @param contentVariables  Map of {"1": "value1", ...} for template variable substitution.
 */
export async function sendViaTwilio(
  to: string,
  text: string,
  mediaUrl?: string,
  contentSid?: string,
  contentVariables?: Record<string, string>,
): Promise<void> {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_WHATSAPP_FROM;

  if (!accountSid) throw createWhatsAppError("Falta configurar TWILIO_ACCOUNT_SID.");
  if (!authToken) throw createWhatsAppError("Falta configurar TWILIO_AUTH_TOKEN.");
  if (!from) throw createWhatsAppError("Falta configurar TWILIO_WHATSAPP_FROM.");

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
        // `from` viene de TWILIO_WHATSAPP_FROM en env (formato fijo
        // `whatsapp:+14155238886` para el sandbox o el WA business number en
        // prod). NO lo pasamos por normalizePhone porque esa función asume
        // input de usuario AR y desconoce el prefijo `whatsapp:` — lo trataba
        // como número local y lo convertía a `+549<sandbox digits>`, un número
        // que no existe. Twilio respondía con 63007 (Channel not found) y el
        // envío silenciosamente fallaba en producción.
        From: from.startsWith("whatsapp:") ? from : `whatsapp:${from}`,
        To: `whatsapp:${normalizePhone(to)}`,
        // Content API path: when ContentSid is provided, omit Body and pass
        // ContentSid + ContentVariables instead. Twilio uses these to render the
        // pre-approved template. Free-text Body is sent otherwise.
        // Ref: https://www.twilio.com/docs/content/send-messages-with-content-api (2026)
        ...(contentSid
          ? {
              ContentSid: contentSid,
              ...(contentVariables && Object.keys(contentVariables).length > 0
                ? { ContentVariables: JSON.stringify(contentVariables) }
                : {}),
            }
          : { Body: text }),
        ...(mediaUrl ? { MediaUrl: mediaUrl } : {}),
        // Delivery status webhook — registered at module load, not per-send.
        // Per-send WARNING removed (downgraded to DEBUG) since the module-load
        // IIFE already logs ERROR once on startup if VELORA_APP_URL is missing.
        ...(process.env.VELORA_APP_URL
          ? { StatusCallback: `${process.env.VELORA_APP_URL.replace(/\/$/, "")}/api/integrations/twilio/status` }
          : {}),
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw createWhatsAppError("La solicitud a Twilio venció después de 15 segundos.");
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const errorBody = await response.text();
    cloudLog({
      severity: "ERROR",
      component: "System",
      action: "WHATSAPP_TWILIO_SEND_FAILED",
      a2a_transfer: false,
      message: `WhatsApp Twilio API error: ${response.status} ${response.statusText}`,
      data: { status: response.status, body: errorBody.slice(0, 500) },
    });
    throw createWhatsAppError("No se pudo enviar el mensaje por WhatsApp (Twilio).");
  }

  // Twilio's 2xx response only means "accepted into queue", not "delivered".
  // Sandbox recipients who haven't sent "join <keyword>" first will silently
  // never receive the message. Log SID + status for correlation.
  const okBody = await response.text();
  let twilioSid: string | undefined;
  let twilioStatus: string | undefined;
  let twilioErrorCode: number | string | undefined;
  let twilioErrorMessage: string | undefined;
  try {
    const parsed = JSON.parse(okBody) as {
      sid?: string;
      status?: string;
      error_code?: number | string | null;
      error_message?: string | null;
    };
    twilioSid = parsed.sid;
    twilioStatus = parsed.status;
    twilioErrorCode = parsed.error_code ?? undefined;
    twilioErrorMessage = parsed.error_message ?? undefined;
  } catch { /* non-JSON response — keep undefined */ }

  cloudLog({
    severity: twilioErrorCode ? "WARNING" : "INFO",
    component: "System",
    action: "WHATSAPP_TWILIO_ACCEPTED",
    a2a_transfer: false,
    message: twilioErrorCode
      ? `Twilio queued the message but reported error_code=${twilioErrorCode}`
      : `Twilio accepted message (sid=${twilioSid ?? "unknown"}, status=${twilioStatus ?? "unknown"})`,
    data: { sid: twilioSid, status: twilioStatus, errorCode: twilioErrorCode, errorMessage: twilioErrorMessage, from },
  });

  if (twilioErrorCode) {
    throw createWhatsAppError(
      `Twilio rechazó el envío (code ${twilioErrorCode}). ${twilioErrorMessage ?? "Verificá que el número haya hecho 'join' al sandbox."}`
    );
  }
}
