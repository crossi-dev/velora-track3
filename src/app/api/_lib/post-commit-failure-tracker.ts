import { prisma } from "@/lib/prisma";
import { cloudLog } from "@/lib/cloud-logger";
import { publishPostCommitFailure } from "./post-commit-failure-publisher";

// Convierte una falla del chain post-commit (push fanout, WA cliente,
// threshold write, etc.) en:
//   1. ChatMessage source="manager" visibility="owner_only" — el dueño lo ve en chat.
//   2. AgentEventLog row — el event-retry cron lo reintenta con backoff exponencial.
//
// Dedup ChatMessage: clientMessageId = `post-commit-failure-${action}-${saleId|noSale}-${date}`.
// P2002 → ya alerteamos hoy con la misma combinación, salimos silenciosos.
//
// Dedup AgentEventLog: eventId = `post-commit-${action}-${saleId|no-sale}`.
// P2002 → ya hay una fila de reintento activa para este (action, saleId), no sobreescribir.

interface FailureRecord {
  businessId: string;
  saleId?: string | null;
  action: string;
  errorMessage: string;
  /** Extra context to persist for replay (e.g. invoiceId). */
  originalArgs?: Record<string, unknown>;
}

export async function recordPostCommitFailure({
  businessId,
  saleId,
  action,
  errorMessage,
  originalArgs,
}: FailureRecord): Promise<void> {
  // 1. Owner-facing chat alert (additive — display sink only, no retry logic here).
  const date = new Date().toISOString().slice(0, 10);
  const clientMessageId = `post-commit-failure-${action}-${saleId ?? "no-sale"}-${date}`;
  const reasonShort = errorMessage.slice(0, 240);
  const saleSuffix = saleId ? ` (venta ${saleId})` : "";
  const text = `⚠ Falla post-venta · ${action}${saleSuffix}\n${reasonShort}`;

  try {
    await prisma.chatMessage.create({
      data: { businessId, clientMessageId, kind: "reply", source: "manager", visibility: "owner_only", text },
    });
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (code !== "P2002") {
      cloudLog({
        severity: "WARNING",
        component: "System",
        action: "POST_COMMIT_FAILURE_TRACKER_FAILED",
        a2a_transfer: false,
        message: "could not write post-commit failure chat alert",
        businessId,
        data: { saleId, action, error: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  // 2. AgentEventLog row for retry cron — fire-and-forget, never throws.
  void publishPostCommitFailure({ businessId, saleId, action, errorMessage, originalArgs });
}
