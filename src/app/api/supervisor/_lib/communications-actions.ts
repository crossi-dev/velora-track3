// communications-actions.ts — Materializes Pattern C intents emitted by the
// Communications ADK agent (send_owner_push / send_employee_push /
// write_owner_chat_message). Called from executeSupActions in owner-handler.ts
// after agentResult.capturedIntents are inlined into supResult.actions.
//
// Each handler:
//   1. Validates the intent data.
//   2. Uses deriveSupervisorIdempotencyKey for dedup (5-second window via
//      idempotencyKey sha256 of seed+intent+data — the DB P2002 retry path
//      in beginIdempotentMutation handles the race).
//   3. Logs success/failure via cloudLog.
//   4. Never throws — try/catch + recordPostCommitFailure (report only, no
//      retry here; the event-retry cron owns replay for non-push actions).
//
// Push handlers (send_owner_push / send_employee_push) live in the sibling
// communications-actions-push.ts to keep this file under the 300-line limit.

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { cloudLog } from "@/lib/cloud-logger";
import { recordPostCommitFailure } from "@/app/api/_lib/post-commit-failure-tracker";
import { deriveSupervisorIdempotencyKey as deriveKey } from "./contract-helpers";
import { handleSms, handleEmail } from "./communications-actions-messaging";
import { handleOwnerPush, handleEmployeePush } from "./communications-actions-push";

// ── Intent names (must match FunctionTool names in communications-agent.tools.ts) ──

const COMM_INTENTS = new Set([
  "send_sms",
  "send_email",
  "send_owner_push",
  "send_employee_push",
  "write_owner_chat_message",
]);

export type CommunicationsAction = { intent: string; data: unknown; summary?: string };

// ── Schema ────────────────────────────────────────────────────────────────────

const OwnerChatSchema = z.object({
  businessId: z.string().min(1),
  text: z.string().min(1).max(2000),
  kind: z.enum(["alert", "info"]),
});

// ── Handler ───────────────────────────────────────────────────────────────────

async function handleOwnerChatWrite(data: unknown, idempotencySeed: string): Promise<void> {
  const parsed = OwnerChatSchema.safeParse(data);
  if (!parsed.success) {
    cloudLog({
      severity: "WARNING",
      component: "Supervisor",
      action: "COMM_CHAT_WRITE_INVALID",
      a2a_transfer: false,
      message: "write_owner_chat_message intent data failed schema validation",
      data: { errors: parsed.error.flatten() },
    });
    return;
  }
  const { businessId, text, kind } = parsed.data;
  const idempotencyKey = deriveKey(idempotencySeed, "write_owner_chat_message", { businessId, text, kind });
  // clientMessageId doubles as dedup key: Prisma P2002 on (clientMessageId) prevents
  // duplicate rows within the same supervisor turn — idempotent by construction.
  const clientMessageId = `comm-chat-${idempotencyKey.slice(0, 24)}`;

  try {
    await prisma.chatMessage.create({
      data: {
        businessId,
        clientMessageId,
        kind: "reply",
        source: "manager",
        visibility: "owner_only",
        text,
      },
    });
    cloudLog({
      severity: "INFO",
      component: "Supervisor",
      action: "COMM_CHAT_WRITE_DONE",
      a2a_transfer: false,
      message: "write_owner_chat_message materialized",
      businessId,
      data: { kind, textLen: text.length },
    });
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    // P2002 = duplicate clientMessageId — already written, not an error.
    if (code === "P2002") return;
    const errorMessage = err instanceof Error ? err.message : String(err);
    cloudLog({
      severity: "ERROR",
      component: "Supervisor",
      action: "COMM_CHAT_WRITE_FAILED",
      a2a_transfer: false,
      message: "write_owner_chat_message prisma.create threw",
      businessId,
      data: { error: errorMessage },
    });
    await recordPostCommitFailure({ businessId, action: "comm.chat-write", errorMessage }).catch(() => {});
  }
}

// ── Recipient-aware dedup ─────────────────────────────────────────────────────

/**
 * Derives a recipient-aware dedup key for a comm intent.
 *
 * Key shape: `${intent}|${recipient}` where recipient is:
 *   - employeeId  for send_employee_push  (different employees → different key → both fire)
 *   - customerId  for send_sms / send_email
 *   - businessId  for send_owner_push / write_owner_chat_message (owner == business)
 *   - ""          when data is not an object or the field is absent (no dedup)
 *
 * This collapses intents targeting the SAME logical recipient within one turn
 * so that a Supervisor-direct emit + a delegated (call_communications_agent) emit
 * with different wording (different data → different DB idempotency hash) cannot
 * produce two pushes for the same recipient.
 */
export function recipientDedupKey(intent: string, data: unknown): string {
  const d = data !== null && typeof data === "object" ? (data as Record<string, unknown>) : null;
  if (!d) return `${intent}|`;
  switch (intent) {
    case "send_employee_push":
      return `${intent}|${typeof d.employeeId === "string" ? d.employeeId : ""}`;
    case "send_sms":
    case "send_email":
      return `${intent}|${typeof d.customerId === "string" ? d.customerId : ""}`;
    case "send_owner_push":
    case "write_owner_chat_message":
      return `${intent}|${typeof d.businessId === "string" ? d.businessId : ""}`;
    default:
      return `${intent}|`;
  }
}

// ── Public entry point ────────────────────────────────────────────────────────

export interface CommunicationsResult {
  handled: number;
  errors: string[];
}

/**
 * Iterates supResult.actions and materializes any communications intents
 * (send_sms / send_email / send_owner_push / send_employee_push / write_owner_chat_message).
 *
 * Recipient-dedup: before dispatching, duplicate intents targeting the SAME
 * logical recipient in one turn are collapsed — only the FIRST occurrence fires.
 * This prevents the direct+delegated dual-emit regression where the Supervisor
 * LLM emits send_owner_push directly AND call_communications_agent returns the
 * same logical push with different wording (different data → different DB
 * idempotency key → two pushes without this guard).
 *
 * Per-handler idempotency (beginIdempotentMutation) still guards against
 * Supervisor retries with byte-identical data, but does NOT prevent same-turn
 * dual-emit with different data — that is what recipient-dedup addresses here.
 *
 * Handlers are fire-and-forget safe: each inner fn catches its own errors.
 * We await all to ensure side-effects complete before the response is sent.
 *
 * @param businessId Optional — forwarded to SMS/email handlers for tenant logging.
 */
export async function executeCommunicationsActions(
  actions: ReadonlyArray<CommunicationsAction>,
  idempotencySeed: string,
  businessId?: string,
): Promise<CommunicationsResult> {
  const commActions = actions.filter((a) => COMM_INTENTS.has(a.intent));
  if (commActions.length === 0) return { handled: 0, errors: [] };

  // Recipient-aware dedup: keep only the FIRST occurrence per intent+recipient key.
  // Two send_employee_push to DIFFERENT employees → different key → both fire.
  // Two send_owner_push in one turn (direct + delegated) → same key → ONE fires.
  const seen = new Set<string>();
  const dedupedActions: CommunicationsAction[] = [];
  for (const a of commActions) {
    const key = recipientDedupKey(a.intent, a.data);
    if (seen.has(key)) {
      cloudLog({
        severity: "WARNING",
        component: "Supervisor",
        action: "COMMS_INTENT_DEDUP",
        a2a_transfer: false,
        message: "comm intent dropped — same recipient already queued this turn (direct+delegated dual-emit guard)",
        businessId,
        data: { intent: a.intent, key },
      });
      continue;
    }
    seen.add(key);
    dedupedActions.push(a);
  }

  const results = await Promise.allSettled(
    dedupedActions.map((a) => {
      switch (a.intent) {
        case "send_sms":
          return handleSms(a.data, `${idempotencySeed}|${a.intent}`, businessId);
        case "send_email":
          return handleEmail(a.data, `${idempotencySeed}|${a.intent}`, businessId);
        case "send_owner_push":
          return handleOwnerPush(a.data, `${idempotencySeed}|${a.intent}`);
        case "send_employee_push":
          return handleEmployeePush(a.data, `${idempotencySeed}|${a.intent}`);
        case "write_owner_chat_message":
          return handleOwnerChatWrite(a.data, `${idempotencySeed}|${a.intent}`);
        default:
          return Promise.resolve();
      }
    }),
  );

  const errors: string[] = [];
  for (const r of results) {
    if (r.status === "rejected") {
      errors.push(r.reason instanceof Error ? r.reason.message : String(r.reason));
    }
  }

  return { handled: dedupedActions.length, errors };
}
