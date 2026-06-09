import { cloudLog } from "@/lib/cloud-logger";
import { resolveMetaCredentialsForBusiness } from "@/lib/whatsapp-meta-credentials";
import { normalizePhoneOrThrow } from "@/lib/phone";

const META_API_BASE_URL = "https://graph.facebook.com/v21.0";
const SEND_TIMEOUT_MS = 15_000;

export type WhatsAppMediaType = "image" | "document" | "audio" | "video";

export interface WhatsAppTemplateComponent {
  type: "body" | "header" | "button";
  parameters: Array<{ type: "text"; text: string }>;
}

function createWhatsAppError(message: string) {
  return new Error(message);
}

export function resolveMetaCredentials(): { accessToken: string; phoneNumberId: string } {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;

  if (!accessToken) throw createWhatsAppError("Falta configurar WHATSAPP_ACCESS_TOKEN.");
  if (!phoneNumberId) throw createWhatsAppError("Falta configurar WHATSAPP_PHONE_NUMBER_ID.");

  return { accessToken, phoneNumberId };
}

export { resolveMetaCredentialsForBusiness };

// REL-N-9: exponential backoff + Retry-After for Meta 5xx retries.
// Max 2 retries (3 total). Retry-After guard: parseInt + isFinite, capped at 10s.
const META_RETRY_MAX_ATTEMPTS = 3;
const META_RETRY_BASE_MS = 1_000;
const META_RETRY_CAP_MS = 10_000;

async function doMetaPost(
  endpoint: string,
  hdrs: Record<string, string>,
  bodyStr: string,
  label: string,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  try {
    return await fetch(endpoint, { method: "POST", headers: hdrs, body: bodyStr, signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw createWhatsAppError(`La solicitud a WhatsApp venció después de ${SEND_TIMEOUT_MS / 1000}s${label}.`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function postToMeta(
  phoneNumberId: string,
  accessToken: string,
  body: Record<string, unknown>,
  action: string
): Promise<void> {
  const endpoint = `${META_API_BASE_URL}/${phoneNumberId}/messages`;
  const hdrs = { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" };
  const bodyStr = JSON.stringify(body);

  let response!: Response;
  for (let attempt = 1; attempt <= META_RETRY_MAX_ATTEMPTS; attempt++) {
    response = await doMetaPost(endpoint, hdrs, bodyStr, attempt > 1 ? ` (retry ${attempt - 1})` : "");
    const retryable = response.status >= 500 && response.status < 600;
    if (!retryable || attempt === META_RETRY_MAX_ATTEMPTS) break;
    // RFC 7231 §7.1.3: Retry-After may be seconds or HTTP-date — guard against NaN.
    const raHeader = response.headers.get("Retry-After");
    const raSecs = raHeader ? parseInt(raHeader, 10) : NaN;
    const base = Number.isFinite(raSecs) && raSecs > 0
      ? Math.min(raSecs * 1_000, META_RETRY_CAP_MS)
      : META_RETRY_BASE_MS * Math.pow(2, attempt - 1);
    const delay = Math.random() * Math.min(base, META_RETRY_CAP_MS); // full jitter
    cloudLog({ severity: "WARNING", component: "System", action: "META_RETRY_5XX", a2a_transfer: false,
      message: `WhatsApp Meta API 5xx — retry ${attempt}/${META_RETRY_MAX_ATTEMPTS - 1} after ${Math.round(delay)}ms (${response.status})`,
      data: { status: response.status, action, attempt, delayMs: Math.round(delay) } });
    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  if (!response.ok) {
    const errorBody = await response.text();
    cloudLog({ severity: "ERROR", component: "System", action, a2a_transfer: false,
      message: `WhatsApp Meta API error: ${response.status} ${response.statusText}`,
      data: { status: response.status, body: errorBody.slice(0, 500) } });
    throw createWhatsAppError("No se pudo enviar el mensaje por WhatsApp (Meta).");
  }
}

/**
 * sendTypingIndicator — shows a "typing…" status (and read receipt) to the
 * customer while a slow reply is being prepared, so a multi-second checkout
 * turn doesn't read as "the bot hung". Marks `messageId` read; the indicator
 * clears when the reply is sent or after 25s (Meta's cap), whichever is first.
 * Call sites MUST treat this as fire-and-forget — never block or fail the real
 * reply on it.
 * Source (verified live HTTP 200): https://developers.facebook.com/docs/whatsapp/cloud-api/typing-indicators/
 */
export async function sendTypingIndicator(businessId: string, messageId: string): Promise<void> {
  const { accessToken, phoneNumberId } = await resolveMetaCredentialsForBusiness(businessId);
  await postToMeta(phoneNumberId, accessToken, {
    messaging_product: "whatsapp",
    status: "read",
    message_id: messageId,
    typing_indicator: { type: "text" },
  }, "META_TYPING_INDICATOR");
}

/**
 * normalizePhone converts an Argentine or international phone number to E.164.
 *
 * Delegates to normalizePhoneOrThrow from @/lib/phone (libphonenumber-js backed).
 * AR mobile-9 convention (+549XXXXXXXXXX) is preserved. Any result that fails
 * E.164 validation throws with a WARNING-logged error rather than silently
 * sending to a malformed number.
 *
 * Source: https://github.com/catamphetamine/libphonenumber-js (VERIFIED HTTP 200, 2026-06-07)
 */
export function normalizePhone(phone: string): string {
  try {
    return normalizePhoneOrThrow(phone);
  } catch (err) {
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "WHATSAPP_INVALID_E164",
      a2a_transfer: false,
      message: `normalizePhone: invalid input — send rejected`,
      data: { inputLength: phone.length, error: err instanceof Error ? err.message : String(err) },
    });
    throw createWhatsAppError(
      err instanceof Error ? err.message : "El teléfono no tiene un formato E.164 válido.",
    );
  }
}

export async function sendMetaText(to: string, text: string, businessId?: string): Promise<void> {
  const { accessToken, phoneNumberId } = await resolveMetaCredentialsForBusiness(businessId);
  await postToMeta(
    phoneNumberId,
    accessToken,
    {
      messaging_product: "whatsapp",
      to: normalizePhone(to),
      type: "text",
      text: { body: text },
    },
    "WHATSAPP_META_SEND_FAILED"
  );
}

/**
 * Send an approved Meta template message (out-of-24h-window safe).
 */
export async function sendMetaTemplate(
  to: string,
  templateName: string,
  components: WhatsAppTemplateComponent[],
  languageCode = "es_AR",
  businessId?: string,
): Promise<void> {
  const { accessToken, phoneNumberId } = await resolveMetaCredentialsForBusiness(businessId);
  await postToMeta(
    phoneNumberId,
    accessToken,
    {
      messaging_product: "whatsapp",
      to: normalizePhone(to),
      type: "template",
      template: {
        name: templateName,
        language: { code: languageCode },
        components,
      },
    },
    "WHATSAPP_META_TEMPLATE_FAILED"
  );
}

/**
 * Send a media message (image, document, audio, or video).
 */
export async function sendMetaMedia(
  to: string,
  mediaType: WhatsAppMediaType,
  mediaUrl: string,
  caption?: string,
  businessId?: string,
): Promise<void> {
  const { accessToken, phoneNumberId } = await resolveMetaCredentialsForBusiness(businessId);
  const mediaObject: Record<string, string> = { link: mediaUrl };
  if (caption) mediaObject.caption = caption;

  await postToMeta(
    phoneNumberId,
    accessToken,
    {
      messaging_product: "whatsapp",
      to: normalizePhone(to),
      type: mediaType,
      [mediaType]: mediaObject,
    },
    "WHATSAPP_META_MEDIA_FAILED"
  );
}

/**
 * Mark an incoming WhatsApp message as read (blue ticks to sender).
 * Non-fatal — logs warnings on failure rather than throwing.
 */
export async function markMetaMessageAsRead(messageId: string, businessId?: string): Promise<void> {
  const { accessToken, phoneNumberId } = await resolveMetaCredentialsForBusiness(businessId);
  const endpoint = `${META_API_BASE_URL}/${phoneNumberId}/messages`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        status: "read",
        message_id: messageId,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      cloudLog({
        severity: "WARNING",
        component: "System",
        action: "WHATSAPP_MARK_READ_FAILED",
        a2a_transfer: false,
        message: `markAsRead failed: ${response.status}`,
        data: { messageId, body: errorBody.slice(0, 300) },
      });
    }
  } catch (err) {
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "WHATSAPP_MARK_READ_ERROR",
      a2a_transfer: false,
      message: `markAsRead threw: ${err instanceof Error ? err.message : String(err)}`,
      data: { messageId },
    });
  } finally {
    clearTimeout(timeout);
  }
}
