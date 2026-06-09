// communications-agent.tools.ts — FunctionTool factories for the Communications ADK agent.
//
// Pattern C: every tool returns { intent, data, summary } instead of executing
// a mutation. The RPC handler captures intents and forwards them as dataParts
// so the downstream pipeline can materialize them through the existing
// idempotent + audited mutation path.
//
// Scope: Web Push (VAPID/FCM), in-app ChatMessage writes.
// Out of scope: WhatsApp — the customer tracking WPP send fires through
// sendCustomerTrackingWpp (direct in-process import), NOT through this agent.
// A dead send_customer_tracking tool was removed 2026-05-28 after audit found
// it was never materialized: agent-call-actions.ts and call-communications-agent-tool.ts
// both drop dataParts for Communications intents. The in-process path is correct.
// Ref: A2A Protocol v1.0 §3 — agent capabilities must be accurate.
// https://a2a-protocol.org/latest/specification/
//
// C-1 guard (OWASP LLM06 — never-fabricate): send_sms and send_email require a
// customerId (DB CUID) instead of a free-form `to` field. The materializer resolves
// the actual phone/email from the Customer record — the LLM identifies WHO, the DB
// supplies the contact. This prevents hallucinated/fabricated phone numbers and emails.
// These channels are BYOA — each business connects their own Twilio/Resend account
// via BusinessChannelCredential. The guard ensures correctness once credentials are connected.

import { z } from "zod/v3";
import { FunctionTool } from "@google/adk";

// ── Factory ──────────────────────────────────────────────────────────────────

interface IntentResult<T = unknown> {
  intent: string;
  data: T;
  summary: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- ADK ships a nested zod copy with nominally distinct types; cast at SDK boundary only.
function buildIntentTool<S extends z.ZodSchema<any>>(opts: {
  name: string;
  description: string;
  schema: S;
  summary: (input: z.infer<S>) => string;
}): FunctionTool {
  return new FunctionTool({
    name: opts.name,
    description: opts.description,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- same SDK-boundary cast as above.
    parameters: opts.schema as any,
    execute: async (input) => {
      const parsed = input as z.infer<S>;
      const result: IntentResult<z.infer<S>> = {
        intent: opts.name,
        data: parsed,
        summary: opts.summary(parsed),
      };
      return result;
    },
  });
}

// ── Schemas ───────────────────────────────────────────────────────────────────

// C-1: customerId replaces free-form `to` — recipient resolved from DB in materializer.
const sendSmsParams = z.object({
  businessId: z.string().describe("Business identifier (CUID) — required for tenant-scoped DB lookup."),
  customerId: z.string().describe("Customer CUID from the database. NEVER fabricate this value — use only IDs provided in the directive context."),
  body: z.string().describe("SMS body text. Keep under 160 chars for a single segment."),
});

// C-1: customerId replaces free-form `to` — recipient resolved from DB in materializer.
const sendEmailParams = z.object({
  businessId: z.string().describe("Business identifier (CUID) — required for tenant-scoped DB lookup."),
  customerId: z.string().describe("Customer CUID from the database. NEVER fabricate this value — use only IDs provided in the directive context."),
  subject: z.string().describe("Email subject line."),
  html: z.string().optional().describe("HTML body. Provide html, text, or both."),
  text: z.string().optional().describe("Plain-text body. Provide html, text, or both."),
});

const sendOwnerPushParams = z.object({
  businessId: z.string().describe("Target business identifier (CUID)."),
  title: z.string().describe("Push notification title — keep under 50 chars."),
  body: z.string().describe("Push notification body — keep under 120 chars."),
  deepLink: z.string().optional().describe(
    "Optional deep-link path (e.g. '/dashboard/ventas') to open when the user taps the notification. Include only when the directive explicitly implies navigation.",
  ),
});

const sendEmployeePushParams = z.object({
  businessId: z.string().describe("Target business identifier (CUID)."),
  employeeId: z.string().describe("Target employee identifier (CUID)."),
  title: z.string().describe("Push notification title — keep under 50 chars."),
  body: z.string().describe("Push notification body — keep under 120 chars."),
  deepLink: z.string().optional().describe(
    "Optional deep-link path to open when the employee taps the notification.",
  ),
});

const writeOwnerChatMessageParams = z.object({
  businessId: z.string().describe("Target business identifier (CUID)."),
  text: z.string().describe("Message text to write to the owner's chat timeline."),
  kind: z.enum(["alert", "info"]).describe(
    '"alert" for actionable warnings (low stock, failed payment). "info" for status updates.',
  ),
});

// ── Tool exports ──────────────────────────────────────────────────────────────

export function buildCommunicationsTools(): FunctionTool[] {
  return [
    buildIntentTool({
      name: "send_sms",
      description:
        "Send a plain SMS to a customer identified by their DB customerId. " +
        "PROHIBICIÓN: NEVER provide a phone number directly — the recipient MUST be identified by customerId. " +
        "The materializer resolves the actual phone from the Customer record. " +
        "Different from WhatsApp — this sends a standard SMS with no session-window restrictions.",
      schema: sendSmsParams,
      summary: (d) => `SMS → customer:${d.customerId}: ${d.body.slice(0, 50)}${d.body.length > 50 ? "…" : ""}`,
    }),

    buildIntentTool({
      name: "send_email",
      description:
        "Send a transactional email to a customer identified by their DB customerId. " +
        "PROHIBICIÓN: NEVER provide an email address directly — the recipient MUST be identified by customerId. " +
        "The materializer resolves the actual email from the Customer record. " +
        "Provide html, text, or both as the message body.",
      schema: sendEmailParams,
      summary: (d) => `Email → customer:${d.customerId}: ${d.subject}`,
    }),

    buildIntentTool({
      name: "send_owner_push",
      description:
        "Send a Web Push (VAPID/FCM) notification to the business owner. Use when the directive targets the owner and push delivery is appropriate (works even when the app is closed). Do NOT use for WhatsApp.",
      schema: sendOwnerPushParams,
      summary: (d) => `Push dueño: ${d.title}`,
    }),

    buildIntentTool({
      name: "send_employee_push",
      description:
        "Send a Web Push (VAPID/FCM) notification to a specific employee. Requires the employee's CUID. Use when the directive targets a named employee and push delivery is appropriate.",
      schema: sendEmployeePushParams,
      summary: (d) => `Push empleado ${d.employeeId}: ${d.title}`,
    }),

    buildIntentTool({
      name: "write_owner_chat_message",
      description:
        "Write a structured message to the owner's in-app chat timeline. Use for alerts (kind='alert') or status info (kind='info') that must appear inline in the chat. Prefer send_owner_push when the app may be closed.",
      schema: writeOwnerChatMessageParams,
      summary: (d) => `Chat dueño [${d.kind}]: ${d.text.slice(0, 60)}${d.text.length > 60 ? "…" : ""}`,
    }),
  ];
}
