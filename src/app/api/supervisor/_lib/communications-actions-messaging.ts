// communications-actions-messaging.ts — Materializers for SMS + email intents
// emitted by the Communications ADK agent (send_sms / send_email).
//
// Sibling of communications-actions.ts. Split here to keep each file ≤300 lines.
// Pattern is identical: validate → dedup → call facade → log → never throw.
//
// Idempotency: each handler calls beginIdempotentMutation with the derived key
// (sha256 of seed|intent|data). On a duplicate key the Prisma P2002 path returns
// kind="replay"/"conflict"/"in_flight" → we short-circuit before touching
// sendSms / sendEmail. This prevents double-sends on supervisor retry.
//
// C-1 guard (OWASP LLM06 — never-fabricate): intent data carries customerId, NOT
// a raw `to` address. The materializer resolves phone/email from the Customer DB
// record (scoped by businessId for tenant isolation) before calling the send facade.
// This ensures the LLM can never fabricate or hallucinate a recipient address.
//
// Credentials are BYOA: sendSms/sendEmail load per-business BusinessChannelCredential
// rows (no global env fallback). Missing credentials → fail-closed error result.

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { cloudLog } from "@/lib/cloud-logger";
import { sendSms } from "@/lib/sms";
import { sendEmail } from "@/lib/email";
import { recordPostCommitFailure } from "@/app/api/_lib/post-commit-failure-tracker";
import { deriveSupervisorIdempotencyKey as deriveKey } from "./contract-helpers";
import {
  beginIdempotentMutation,
  completeIdempotentMutation,
  releaseIdempotentMutation,
} from "@/app/api/_lib/idempotency";

// ── Schemas (mirror communications-agent.tools.ts — customerId replaces raw `to`) ──

const SmsSchema = z.object({
  businessId: z.string().min(1),
  customerId: z.string().min(1),
  body: z.string().min(1).max(1600),
});

const EmailSchema = z.object({
  businessId: z.string().min(1),
  customerId: z.string().min(1),
  subject: z.string().min(1),
  html: z.string().optional(),
  text: z.string().optional(),
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function resolveCustomerPhone(businessId: string, customerId: string): Promise<string | null> {
  const customer = await prisma.customer.findFirst({
    where: { id: customerId, businessId },
    select: { phone: true },
  });
  return customer?.phone ?? null;
}

async function resolveCustomerEmail(businessId: string, customerId: string): Promise<string | null> {
  const customer = await prisma.customer.findFirst({
    where: { id: customerId, businessId },
    select: { email: true },
  });
  return customer?.email ?? null;
}

// ── Handlers ──────────────────────────────────────────────────────────────────

export async function handleSms(
  data: unknown,
  idempotencySeed: string,
  _callerBusinessId?: string,
): Promise<void> {
  const parsed = SmsSchema.safeParse(data);
  if (!parsed.success) {
    cloudLog({
      severity: "WARNING",
      component: "Supervisor",
      action: "COMM_SMS_INVALID",
      a2a_transfer: false,
      message: "send_sms intent data failed schema validation",
      data: { errors: parsed.error.flatten() },
    });
    return;
  }
  const { businessId, customerId, body } = parsed.data;

  // C-1: resolve phone from DB — never trust LLM-supplied recipient address.
  const to = await resolveCustomerPhone(businessId, customerId);
  if (!to) {
    cloudLog({
      severity: "WARNING",
      component: "Supervisor",
      action: "COMM_SMS_NO_PHONE",
      a2a_transfer: false,
      message: "send_sms: customer has no phone number on record — skipped",
      businessId,
      data: { customerId },
    });
    return;
  }

  // Derive a stable key scoped to seed + intent + content for dedup.
  const idempotencyKey = deriveKey(idempotencySeed, "send_sms", { customerId, body });

  // Idempotency gate: prevents double-sends on supervisor retry.
  const idem = await beginIdempotentMutation({
    client: prisma,
    businessId,
    actionType: "comm.sms",
    idempotencyKey,
    requestBody: { customerId, body },
  });
  if (idem.kind !== "execute") {
    cloudLog({
      severity: "INFO",
      component: "Supervisor",
      action: "COMM_SMS_DEDUPED",
      a2a_transfer: false,
      message: `send_sms deduplicated (kind=${idem.kind}) — facade NOT called`,
      businessId,
      data: { customerId, kind: idem.kind },
    });
    return;
  }
  const { recordId } = idem;

  const result = await sendSms({ to, body }, businessId);
  if (!result.ok) {
    await releaseIdempotentMutation({ client: prisma, recordId });
    cloudLog({
      severity: "ERROR",
      component: "Supervisor",
      action: "COMM_SMS_FAILED",
      a2a_transfer: false,
      message: `send_sms failed: ${result.error}`,
      businessId,
      data: { customerId, error: result.error },
    });
    await recordPostCommitFailure({ businessId, action: "comm.sms", errorMessage: result.error }).catch(() => {});
    return;
  }

  await completeIdempotentMutation({ client: prisma, recordId, responseStatus: 200, responseBody: { ok: true, sid: result.sid } });
  cloudLog({
    severity: "INFO",
    component: "Supervisor",
    action: "COMM_SMS_SENT",
    a2a_transfer: false,
    message: `send_sms materialized (sid=${result.sid})`,
    businessId,
    data: { customerId, sid: result.sid },
  });
}

export async function handleEmail(
  data: unknown,
  idempotencySeed: string,
  _callerBusinessId?: string,
): Promise<void> {
  const parsed = EmailSchema.safeParse(data);
  if (!parsed.success) {
    cloudLog({
      severity: "WARNING",
      component: "Supervisor",
      action: "COMM_EMAIL_INVALID",
      a2a_transfer: false,
      message: "send_email intent data failed schema validation",
      data: { errors: parsed.error.flatten() },
    });
    return;
  }
  const { businessId, customerId, subject, html, text } = parsed.data;

  if (!html && !text) {
    cloudLog({
      severity: "WARNING",
      component: "Supervisor",
      action: "COMM_EMAIL_NO_BODY",
      a2a_transfer: false,
      message: "send_email intent has neither html nor text body — skipped",
      businessId,
      data: { customerId, subject },
    });
    return;
  }

  // C-1: resolve email from DB — never trust LLM-supplied recipient address.
  const to = await resolveCustomerEmail(businessId, customerId);
  if (!to) {
    cloudLog({
      severity: "WARNING",
      component: "Supervisor",
      action: "COMM_EMAIL_NO_ADDRESS",
      a2a_transfer: false,
      message: "send_email: customer has no email address on record — skipped",
      businessId,
      data: { customerId, subject },
    });
    return;
  }

  // Derive a stable key scoped to seed + intent + content for dedup.
  const idempotencyKey = deriveKey(idempotencySeed, "send_email", { customerId, subject });

  // Idempotency gate: prevents double-sends on supervisor retry.
  const idem = await beginIdempotentMutation({
    client: prisma,
    businessId,
    actionType: "comm.email",
    idempotencyKey,
    requestBody: { customerId, subject },
  });
  if (idem.kind !== "execute") {
    cloudLog({
      severity: "INFO",
      component: "Supervisor",
      action: "COMM_EMAIL_DEDUPED",
      a2a_transfer: false,
      message: `send_email deduplicated (kind=${idem.kind}) — facade NOT called`,
      businessId,
      data: { customerId, subject, kind: idem.kind },
    });
    return;
  }
  const { recordId } = idem;

  const result = await sendEmail({ to, subject, html, text }, businessId);
  if (!result.ok) {
    await releaseIdempotentMutation({ client: prisma, recordId });
    cloudLog({
      severity: "ERROR",
      component: "Supervisor",
      action: "COMM_EMAIL_FAILED",
      a2a_transfer: false,
      message: `send_email failed: ${result.error}`,
      businessId,
      data: { customerId, subject, error: result.error },
    });
    await recordPostCommitFailure({ businessId, action: "comm.email", errorMessage: result.error }).catch(() => {});
    return;
  }

  await completeIdempotentMutation({ client: prisma, recordId, responseStatus: 200, responseBody: { ok: true, id: result.id } });
  cloudLog({
    severity: "INFO",
    component: "Supervisor",
    action: "COMM_EMAIL_SENT",
    a2a_transfer: false,
    message: `send_email materialized (id=${result.id})`,
    businessId,
    data: { customerId, id: result.id },
  });
}
