/**
 * WhatsApp send façade — routes to Meta Cloud API (default) or Twilio sandbox.
 *
 * Provider modules:
 *   src/lib/whatsapp-meta.ts   — Meta Cloud API (text, template, media, read receipt)
 *   src/lib/whatsapp-twilio.ts — Twilio (text + media via MediaUrl)
 */

export type { WhatsAppMediaType, WhatsAppTemplateComponent } from "@/lib/whatsapp-meta";

import { cloudLog } from "@/lib/cloud-logger";
import {
  sendMetaText,
  sendMetaTemplate,
  sendMetaMedia,
  markMetaMessageAsRead,
  normalizePhone,
  type WhatsAppMediaType,
  type WhatsAppTemplateComponent,
} from "@/lib/whatsapp-meta";
import { sendViaTwilio } from "@/lib/whatsapp-twilio";

function createWhatsAppError(message: string) {
  return new Error(message);
}

function activeProvider(): "meta" | "twilio" {
  const p = (process.env.WHATSAPP_PROVIDER ?? "meta").trim().toLowerCase();
  return p === "twilio" ? "twilio" : "meta";
}

export function toUserVisibleWhatsAppErrorMessage(error: unknown, fallback: string) {
  if (!(error instanceof Error)) return fallback;

  const message = error.message.trim();
  if (!message) return fallback;

  // "Falta configurar X" names internal env vars — translate to something
  // actionable for the end user.
  if (message.startsWith("Falta configurar")) {
    return "El envío por WhatsApp no está configurado en este momento.";
  }

  // Messages already written for the end user pass through unchanged.
  if (
    message.startsWith("Hace falta") ||
    message.startsWith("El teléfono") ||
    message.startsWith("La solicitud")
  ) {
    return message;
  }

  return fallback;
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Send a plain text message (+ optional media attachment).
 * Routes to Meta Cloud API or Twilio based on WHATSAPP_PROVIDER.
 *
 * @param businessId — when provided, resolves per-tenant WabaConnection credentials
 *   instead of falling back to the global WHATSAPP_ACCESS_TOKEN env var.
 *   Required for post-payment comprobante / tracking sends (per-tenant Meta path).
 *   Optional for backward-compatibility — existing callers without businessId keep
 *   the current behavior (global env fallback or Twilio).
 */
export async function sendWhatsAppMessage(
  to: string,
  text: string,
  mediaUrl?: string,
  businessId?: string,
): Promise<void> {
  const normalizedTo = to.trim();
  const normalizedText = text.trim();

  if (!normalizedTo) throw createWhatsAppError("Hace falta el teléfono del destinatario.");
  if (!normalizedText) throw createWhatsAppError("Hace falta el texto del mensaje.");

  if (activeProvider() === "twilio") {
    await sendViaTwilio(normalizedTo, normalizedText, mediaUrl);
    return;
  }

  // Meta path: if a mediaUrl is provided, send as document + caption
  if (mediaUrl) {
    await sendMetaMedia(normalizedTo, "document", mediaUrl, normalizedText, businessId);
    return;
  }

  await sendMetaText(normalizedTo, normalizedText, businessId);
}

/**
 * Send an approved Meta template message (out-of-24h-window safe).
 *
 * Twilio path: uses Content API (ContentSid + ContentVariables) when
 * TWILIO_CONTENT_SID_TRACKING_UPDATE is configured. This is the only way
 * Twilio can send pre-approved template messages outside the 24-hour
 * conversation window — free-text sends fail silently with error 131026.
 * If the env var is not set, falls through to free-text (preserves today's
 * behavior on unconfigured deployments) with a WARNING log.
 * Ref: https://www.twilio.com/docs/content/create-templates-with-the-content-api (2026)
 *
 * Meta path: delegates to sendMetaTemplate (unchanged).
 */
export async function sendWhatsAppTemplate(
  to: string,
  templateName: string,
  components: WhatsAppTemplateComponent[],
  languageCode = "es_AR",
  businessId?: string,
): Promise<void> {
  const normalizedTo = to.trim();
  if (!normalizedTo) throw createWhatsAppError("Hace falta el teléfono del destinatario.");

  if (activeProvider() === "twilio") {
    // Twilio Content API: look up the ContentSid for this template name.
    // Supported mapping: "velora_tracking_update" → TWILIO_CONTENT_SID_TRACKING_UPDATE.
    // Extend this map when new templates are approved.
    const contentSidEnvMap: Record<string, string | undefined> = {
      velora_tracking_update: process.env.TWILIO_CONTENT_SID_TRACKING_UPDATE,
    };
    const contentSid = contentSidEnvMap[templateName];

    if (!contentSid) {
      cloudLog({
        severity: "WARNING",
        component: "System",
        action: "WHATSAPP_TEMPLATE_TWILIO_NO_CONTENT_SID",
        a2a_transfer: false,
        message: `Template "${templateName}" has no TWILIO_CONTENT_SID configured. ` +
          `Outside the 24h Meta session window, Twilio will reject this with error 131026. ` +
          `Set TWILIO_CONTENT_SID_${templateName.toUpperCase()} to activate the Content API path.`,
        data: { templateName, to: normalizedTo },
      });
      throw createWhatsAppError(
        `Template "${templateName}" has no TWILIO_CONTENT_SID configured — send aborted.`,
      );
    }

    // Build ContentVariables from the body component parameters (flat index map).
    // Twilio Content API expects: { "1": "value1", "2": "value2", ... }
    // Ref: https://www.twilio.com/docs/content/send-messages-with-content-api#content-variables (2026)
    const bodyComponent = components.find((c) => c.type === "body");
    const contentVariables: Record<string, string> = {};
    if (bodyComponent) {
      bodyComponent.parameters.forEach((p, i) => {
        contentVariables[String(i + 1)] = p.text;
      });
    }

    await sendViaTwilio(normalizedTo, "", undefined, contentSid, contentVariables);
    return;
  }

  await sendMetaTemplate(normalizedTo, templateName, components, languageCode, businessId);
}

/**
 * Send a media message (image, document, audio, or video).
 * Twilio: uses MediaUrl; caption not supported.
 */
export async function sendWhatsAppMedia(
  to: string,
  mediaType: WhatsAppMediaType,
  mediaUrl: string,
  caption?: string
): Promise<void> {
  const normalizedTo = to.trim();
  if (!normalizedTo) throw createWhatsAppError("Hace falta el teléfono del destinatario.");
  if (!mediaUrl.trim()) throw createWhatsAppError("Hace falta la URL del archivo.");

  if (activeProvider() === "twilio") {
    await sendViaTwilio(normalizedTo, caption ?? "", mediaUrl);
    return;
  }

  await sendMetaMedia(normalizedTo, mediaType, mediaUrl, caption);
}

/**
 * Mark an incoming WhatsApp message as read (blue ticks).
 * No-op on Twilio.
 */
export async function markWhatsAppMessageAsRead(messageId: string): Promise<void> {
  if (activeProvider() === "twilio") return;
  await markMetaMessageAsRead(messageId);
}

// Re-export normalizePhone for consumers that need phone validation.
export { normalizePhone };
