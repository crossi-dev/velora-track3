// src/lib/mcp/_lib/messaging-backend.port.ts — Backend-agnostic port for messaging MCP tools.
//
// Decouples the 2 messaging tools from Velora's concrete lib functions.
// A future adapter implements this interface and requires ZERO changes to
// messaging-tools.ts or the MCP server.
//
// Design mirrors catalog-backend.port.ts / engine-adapter.ts:
//   port (this file) → adapter (velora-messaging.adapter.ts) → factory (messaging-backend.factory.ts)
//
// tenantId is opaque here — the Velora adapter maps it to businessId internally.
//
// Input/output types mirror the handler shapes in messaging-tools.ts.
// They are intentionally narrow (tool-contract shapes) — not full domain types.
// The port is a seam, not a transport model.

import type { WhatsAppTemplateComponent } from "@/lib/whatsapp";

export interface SendWhatsappTextInput {
  tenantId: string;
  to: string;
  text: string;
  mediaUrl?: string;
}

export interface SendWhatsappTemplateInput {
  tenantId: string;
  to: string;
  templateName: string;
  components: WhatsAppTemplateComponent[];
  languageCode?: string;
}

/**
 * Backend-agnostic messaging port for the MCP messaging tool pack.
 *
 * Every method maps to one MCP tool (send_whatsapp_text, send_whatsapp_template).
 * WhatsApp methods throw on failure — matching the underlying lib function contracts.
 *
 * Tenant isolation is enforced by each adapter via the opaque tenantId field.
 * WHATSAPP_PROVIDER selection inside whatsapp.ts is untouched — this port is
 * provider-selection agnostic; it delegates to the lib façade.
 */
export interface MessagingBackend {
  sendWhatsappText(input: SendWhatsappTextInput): Promise<void>;
  sendWhatsappTemplate(input: SendWhatsappTemplateInput): Promise<void>;
}
