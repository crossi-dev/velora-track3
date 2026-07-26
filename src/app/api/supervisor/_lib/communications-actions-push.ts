// communications-actions-push.ts — Materializers for push notification intents
// emitted by the Communications ADK agent (send_owner_push / send_employee_push).
//
// Sibling of communications-actions.ts. Split here to keep each file ≤300 lines.
// Pattern is identical to communications-actions-messaging.ts:
//   validate → idempotency gate → send → log → never throw.
//
// Idempotency: beginIdempotentMutation gates each push behind a DB row keyed by
// (businessId, actionType, derived-sha256-key). This prevents duplicate pushes
// on Supervisor retry — the same fix applied to SMS/email (comm.sms/comm.email).

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { cloudLog } from "@/lib/cloud-logger";
import { sendPushToOwner } from "@/app/api/_lib/owner-push";
import { recordPostCommitFailure } from "@/app/api/_lib/post-commit-failure-tracker";
import { deriveSupervisorIdempotencyKey as deriveKey } from "./contract-helpers";
import {
  beginIdempotentMutation,
  completeIdempotentMutation,
  releaseIdempotentMutation,
} from "@/app/api/_lib/idempotency";

// ── Schemas (mirror communications-agent.tools.ts) ────────────────────────────

const OwnerPushSchema = z.object({
  businessId: z.string().min(1),
  title: z.string().min(1).max(80),
  body: z.string().min(1).max(200),
  deepLink: z.string().optional(),
});

const EmployeePushSchema = z.object({
  businessId: z.string().min(1),
  employeeId: z.string().min(1),
  title: z.string().min(1).max(80),
  body: z.string().min(1).max(200),
  deepLink: z.string().optional(),
});

// ── Handlers ──────────────────────────────────────────────────────────────────

export async function handleOwnerPush(data: unknown, idempotencySeed: string): Promise<void> {
  const parsed = OwnerPushSchema.safeParse(data);
  if (!parsed.success) {
    cloudLog({
      severity: "WARNING",
      component: "Supervisor",
      action: "COMM_OWNER_PUSH_INVALID",
      a2a_transfer: false,
      message: "send_owner_push intent data failed schema validation",
      data: { errors: parsed.error.flatten() },
    });
    return;
  }
  const { businessId, title, body, deepLink } = parsed.data;
  const idempotencyKey = deriveKey(idempotencySeed, "send_owner_push", { businessId, title, body });

  // DB gate: prevents duplicate push on Supervisor retry (same pattern as handleSms/handleEmail).
  const idem = await beginIdempotentMutation({
    client: prisma,
    businessId,
    actionType: "comm.owner-push",
    idempotencyKey,
    requestBody: { title, body },
  });
  if (idem.kind !== "execute") {
    cloudLog({
      severity: "INFO",
      component: "Supervisor",
      action: "COMM_OWNER_PUSH_DEDUPED",
      a2a_transfer: false,
      message: `send_owner_push deduplicated (kind=${idem.kind}) — push NOT sent`,
      businessId,
      data: { kind: idem.kind },
    });
    return;
  }
  const { recordId } = idem;

  try {
    const result = await sendPushToOwner(businessId, {
      title,
      body,
      url: deepLink ?? "/dashboard",
      notificationCategory: "default",
      entityId: `comm-owner-push:${idempotencyKey.slice(0, 16)}`,
    });
    await completeIdempotentMutation({ client: prisma, recordId, responseStatus: 200, responseBody: { sent: result.sent } });
    cloudLog({
      severity: "INFO",
      component: "Supervisor",
      action: "COMM_OWNER_PUSH_SENT",
      a2a_transfer: false,
      message: "send_owner_push materialized",
      businessId,
      data: { attempted: result.attempted, sent: result.sent, expired: result.expired },
    });
  } catch (err) {
    await releaseIdempotentMutation({ client: prisma, recordId });
    const errorMessage = err instanceof Error ? err.message : String(err);
    cloudLog({
      severity: "ERROR",
      component: "Supervisor",
      action: "COMM_OWNER_PUSH_FAILED",
      a2a_transfer: false,
      message: "send_owner_push threw unexpectedly",
      businessId,
      data: { error: errorMessage },
    });
    await recordPostCommitFailure({ businessId, action: "comm.owner-push", errorMessage }).catch(() => {});
  }
}

export async function handleEmployeePush(data: unknown, idempotencySeed: string): Promise<void> {
  const parsed = EmployeePushSchema.safeParse(data);
  if (!parsed.success) {
    cloudLog({
      severity: "WARNING",
      component: "Supervisor",
      action: "COMM_EMPLOYEE_PUSH_INVALID",
      a2a_transfer: false,
      message: "send_employee_push intent data failed schema validation",
      data: { errors: parsed.error.flatten() },
    });
    return;
  }
  const { businessId, employeeId, title, body, deepLink } = parsed.data;
  const idempotencyKey = deriveKey(idempotencySeed, "send_employee_push", { businessId, employeeId, title, body });

  // DB gate: prevents duplicate push on Supervisor retry (same pattern as handleSms/handleEmail).
  const idem = await beginIdempotentMutation({
    client: prisma,
    businessId,
    actionType: "comm.employee-push",
    idempotencyKey,
    requestBody: { employeeId, title, body },
  });
  if (idem.kind !== "execute") {
    cloudLog({
      severity: "INFO",
      component: "Supervisor",
      action: "COMM_EMPLOYEE_PUSH_DEDUPED",
      a2a_transfer: false,
      message: `send_employee_push deduplicated (kind=${idem.kind}) — push NOT sent`,
      businessId,
      data: { employeeId, kind: idem.kind },
    });
    return;
  }
  const { recordId } = idem;

  try {
    // Employee concept removed (0 rows in production, Stage 1 cleanup) — no
    // employee device to push to. Idempotency record still completes so a
    // Supervisor retry of the same send_employee_push intent doesn't loop.
    void employeeId;
    await completeIdempotentMutation({ client: prisma, recordId, responseStatus: 200, responseBody: { ok: true } });
    cloudLog({
      severity: "INFO",
      component: "Supervisor",
      action: "COMM_EMPLOYEE_PUSH_SENT",
      a2a_transfer: false,
      message: "send_employee_push materialized",
      businessId,
      data: { employeeId },
    });
  } catch (err) {
    await releaseIdempotentMutation({ client: prisma, recordId });
    const errorMessage = err instanceof Error ? err.message : String(err);
    cloudLog({
      severity: "ERROR",
      component: "Supervisor",
      action: "COMM_EMPLOYEE_PUSH_FAILED",
      a2a_transfer: false,
      message: "send_employee_push threw unexpectedly",
      businessId,
      data: { employeeId, error: errorMessage },
    });
    await recordPostCommitFailure({ businessId, action: "comm.employee-push", errorMessage }).catch(() => {});
  }
}
