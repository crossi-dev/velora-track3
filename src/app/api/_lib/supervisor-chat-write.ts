// Shared helper: write a ChatMessage for an owner-visible supervisor alert.
//
// Audit finding: supervisor-side notify_now paths fired the push but never
// wrote into the chat thread, so the owner saw an OS notification but the
// chat history was mute. The Pub/Sub handler had this fix locally; the
// loopback and retry paths did not. This helper centralizes the write so
// all three call sites stay in sync.
//
// Idempotent via clientMessageId = `supervisor-alert-${eventId}`. P2002 on
// duplicate is logged at INFO; any other error is logged at WARNING and the
// caller is expected to continue with the push (best-effort).

import { prisma } from "@/lib/prisma";
import { cloudLog } from "@/lib/cloud-logger";

export interface SupervisorAlertChatArgs {
  businessId: string;
  eventId: string;
  body: string;
}

export async function writeSupervisorAlertChat(args: SupervisorAlertChatArgs): Promise<void> {
  const clientMessageId = `supervisor-alert-${args.eventId}`;
  try {
    await prisma.chatMessage.create({
      data: {
        businessId: args.businessId,
        clientMessageId,
        kind: "reply",
        source: "manager",
        visibility: "owner_only",
        text: args.body,
      },
    });
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === "P2002") {
      cloudLog({
        severity: "INFO", component: "System", action: "SUPERVISOR_CHAT_MSG_DEDUP",
        a2a_transfer: false,
        message: `ChatMessage dedup — already written for eventId ${args.eventId}`,
        businessId: args.businessId, eventId: args.eventId, data: {},
      });
      return;
    }
    cloudLog({
      severity: "WARNING", component: "System", action: "SUPERVISOR_CHAT_MSG_WRITE_FAILED",
      a2a_transfer: false,
      message: `ChatMessage write failed for eventId ${args.eventId} — push will still proceed`,
      businessId: args.businessId, eventId: args.eventId,
      data: { code, error: err instanceof Error ? err.message.slice(0, 300) : String(err) },
    });
  }
}
