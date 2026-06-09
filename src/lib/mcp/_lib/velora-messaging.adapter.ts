// src/lib/mcp/_lib/velora-messaging.adapter.ts — Velora concrete implementation of MessagingBackend.
//
// Wraps the existing lib functions: sendWhatsAppMessage, sendWhatsAppTemplate (whatsapp.ts).
// Pure structural wrap — zero behavioral change. tenantId is mapped to businessId
// before every lib call (the libs require businessId for per-business BYOA credential lookup).
//
// WHATSAPP_PROVIDER selection inside whatsapp.ts is untouched — this adapter delegates
// to the provider façade, not to any specific provider directly.
//
// Design source: velora-catalog.adapter.ts (composition over inheritance, thin delegation).

import type {
  MessagingBackend,
  SendWhatsappTextInput,
  SendWhatsappTemplateInput,
} from "./messaging-backend.port";
import { sendWhatsAppMessage, sendWhatsAppTemplate } from "@/lib/whatsapp";

export class VeloraMessagingAdapter implements MessagingBackend {
  async sendWhatsappText(input: SendWhatsappTextInput): Promise<void> {
    const { tenantId: businessId, to, text, mediaUrl } = input;
    await sendWhatsAppMessage(to, text, mediaUrl, businessId);
  }

  async sendWhatsappTemplate(input: SendWhatsappTemplateInput): Promise<void> {
    const { tenantId: businessId, to, templateName, components, languageCode } = input;
    await sendWhatsAppTemplate(to, templateName, components, languageCode, businessId);
  }
}
