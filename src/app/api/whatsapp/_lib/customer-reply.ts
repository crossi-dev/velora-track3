// customer-reply.ts — Sends a Customer Agent reply back to the customer via WhatsApp.
//
// JD C1 fix (2026-05-28): reply MUST use the SAME provider that delivered the
// inbound message, not the global WHATSAPP_PROVIDER default. Otherwise an
// inbound Twilio sandbox message gets a Meta-Cloud reply attempt that fails
// silently because there's no active Meta conversation window for that number.
//
// Error handling: logs failures but does NOT throw — the webhook handler catches
// errors at the loop level and must always return 200 to Meta/Twilio.
//
// Sources:
//   Meta Cloud API send message:
//     https://developers.facebook.com/docs/whatsapp/cloud-api/messages
//   Twilio webhook request format (inbound + outbound):
//     https://www.twilio.com/docs/messaging/guides/webhook-request

import "server-only";

import { cloudLog } from "@/lib/cloud-logger";
import { sendMetaText } from "@/lib/whatsapp-meta";
import { sendViaTwilio } from "@/lib/whatsapp-twilio";

// ── Types ─────────────────────────────────────────────────────────────────────

export type SendReplyArgs = {
  toPhoneE164: string;
  text: string;
  /** Provider that delivered the inbound message — reply MUST use the same. */
  provider: "meta" | "twilio";
  /** For log scope only — not used in the send call. */
  businessId: string;
  /** For log correlation. */
  messageId?: string;
};

// ── Reply ─────────────────────────────────────────────────────────────────────

/**
 * Send the Customer Agent's reply to the inbound customer's phone.
 *
 * Does NOT throw — errors are caught, logged, and swallowed.
 * The webhook must return 200 regardless; the calling loop handles continuity.
 */
export async function sendCustomerAgentReply(args: SendReplyArgs): Promise<void> {
  const { toPhoneE164, text, provider, businessId, messageId } = args;

  try {
    if (provider === "twilio") {
      await sendViaTwilio(toPhoneE164, text);
    } else {
      // Pass businessId so the send uses the tenant's own WabaConnection token
      // when available, falling back to the global env creds if not.
      await sendMetaText(toPhoneE164, text, businessId);
    }

    cloudLog({
      severity: "INFO",
      component: "WhatsApp",
      action: "WEBHOOK_REPLY_SENT",
      a2a_transfer: false,
      message: `Customer Agent reply sent via ${provider} (${text.length} chars)`,
      data: { businessId, toPhoneE164, provider, messageId: messageId ?? null },
    });
  } catch (err) {
    cloudLog({
      severity: "ERROR",
      component: "WhatsApp",
      action: "WEBHOOK_REPLY_FAILED",
      a2a_transfer: false,
      message: `Failed to send Customer Agent reply via ${provider}: ${err instanceof Error ? err.message : String(err)}`,
      data: { businessId, toPhoneE164, provider, messageId: messageId ?? null },
    });
    // DO NOT re-throw — caller must return 200 to Meta/Twilio.
  }
}
