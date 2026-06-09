// DLQ handler factory for Pub/Sub push subscribers.
//
// Both payment-confirm and payment-cancel DLQ handlers share the same flow:
//   1. Verify Pub/Sub OIDC token (via makePubSubOidcVerifier).
//   2. Parse Pub/Sub push envelope + base64-decode Cloud Tasks payload.
//   3. Upsert DLQ record (idempotent on taskName unique constraint).
//   4. recordCriticalWriteEvent for ops audit trail.
//
// buildDlqHandler returns a POST handler function ready to be used with
// runWithTraceContext.
//
// Ref: https://cloud.google.com/pubsub/docs/push#authentication_and_authorization
// Ref: https://cloud.google.com/tasks/docs/reference/rest/v2/projects.locations.queues#RetryConfig

import { NextRequest, NextResponse } from "next/server";
import { cloudLog } from "@/lib/cloud-logger";
import { prisma } from "@/lib/prisma";
import { recordCriticalWriteEvent } from "@/infrastructure/shared/critical-write-audit";
import { makePubSubOidcVerifier } from "./oidc-verifiers";

// ── Shared Pub/Sub envelope types ────────────────────────────────────────────

interface PubSubMessage {
  data?: string;
  attributes?: Record<string, string>;
  messageId?: string;
}

interface PubSubBody {
  message?: PubSubMessage;
  subscription?: string;
}

// ── Payload extraction ───────────────────────────────────────────────────────

function extractTaskPayload(rawData: string): {
  paymentIntentId: string;
  businessId: string;
} | null {
  try {
    const decoded = Buffer.from(rawData, "base64").toString("utf-8");
    const parsed: unknown = JSON.parse(decoded);
    if (
      parsed &&
      typeof parsed === "object" &&
      "paymentIntentId" in parsed &&
      "businessId" in parsed &&
      typeof (parsed as Record<string, unknown>).paymentIntentId === "string" &&
      typeof (parsed as Record<string, unknown>).businessId === "string"
    ) {
      return {
        paymentIntentId: (parsed as Record<string, string>).paymentIntentId,
        businessId: (parsed as Record<string, string>).businessId,
      };
    }
  } catch {
    // fall through
  }
  return null;
}

// ── Factory ──────────────────────────────────────────────────────────────────

export interface DlqHandlerOptions {
  /**
   * Absolute path suffix for the OIDC audience, e.g. "/api/internal/dlq/payment-confirm".
   */
  audiencePath: string;
  /**
   * Upper-cased prefix for log action codes, e.g. "CONFIRM" → DLQ_CONFIRM_AUTH_FAILED.
   */
  actionPrefix: string;
  /**
   * Human-readable queue name used in log messages, e.g. "payment-confirm".
   */
  queueName: string;
  /**
   * actionType recorded in the critical-write audit event, e.g. "payment_confirm_dlq".
   */
  actionType: string;
  /**
   * Prisma model delegate with the upsert method — pass `prisma.paymentConfirmDlq`
   * or `prisma.paymentCancelDlq`. Must have taskName (unique), paymentIntentId,
   * businessId, rawMessage, attemptCount, updatedAt fields.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Prisma delegate types differ per-model; any is the canonical escape hatch for factory patterns
  dlqModel: { upsert: (args: any) => Promise<unknown> };
}

/**
 * Returns an async POST handler (NextRequest → NextResponse) for a DLQ Pub/Sub
 * push endpoint. The caller wraps it with runWithTraceContext.
 */
export function buildDlqHandler(opts: DlqHandlerOptions): (req: NextRequest) => Promise<NextResponse> {
  const verifyPubSubToken = makePubSubOidcVerifier({ audiencePath: opts.audiencePath });
  const P = opts.actionPrefix;

  return async function handlePost(req: NextRequest): Promise<NextResponse> {
    const authHeader = req.headers.get("authorization");
    const tokenValid = await verifyPubSubToken(authHeader);

    if (!tokenValid) {
      cloudLog({
        severity: "WARNING",
        component: "System",
        action: `DLQ_${P}_AUTH_FAILED`,
        a2a_transfer: false,
        message: `${opts.queueName} DLQ push auth failed — invalid or missing OIDC token`,
      });
      // Return 200 to prevent Pub/Sub from endlessly retrying bad-auth messages.
      return NextResponse.json({ ok: false, error: "auth_failed" });
    }

    let body: PubSubBody;
    try {
      body = (await req.json()) as PubSubBody;
    } catch {
      cloudLog({
        severity: "ERROR",
        component: "System",
        action: `DLQ_${P}_BAD_BODY`,
        a2a_transfer: false,
        message: `${opts.queueName} DLQ push body is not valid JSON`,
      });
      return NextResponse.json({ ok: false, error: "bad_body" });
    }

    const message = body?.message;
    if (!message?.data) {
      cloudLog({
        severity: "ERROR",
        component: "System",
        action: `DLQ_${P}_NO_DATA`,
        a2a_transfer: false,
        message: `${opts.queueName} DLQ push message has no data field`,
      });
      return NextResponse.json({ ok: false, error: "no_data" });
    }

    const taskName = message.attributes?.["CloudTasksTaskName"] ?? message.messageId ?? "unknown";
    const attemptStr = message.attributes?.["CloudTasksTaskRetryCount"] ?? "0";
    const attemptCount = parseInt(attemptStr, 10) || 0;

    const extracted = extractTaskPayload(message.data);
    const paymentIntentId = extracted?.paymentIntentId ?? "unknown";
    const businessId = extracted?.businessId ?? "unknown";

    cloudLog({
      severity: "ERROR",
      component: "System",
      action: `DLQ_${P}_RECEIVED`,
      a2a_transfer: false,
      message: `${opts.queueName} DLQ: task exhausted all retries paymentIntentId=${paymentIntentId}`,
      businessId,
      data: { paymentIntentId, taskName, attemptCount },
    });

    // Upsert DLQ record — idempotent on taskName unique constraint.
    try {
      await opts.dlqModel.upsert({
        where: { taskName },
        create: {
          taskName,
          paymentIntentId,
          businessId,
          rawMessage: message.data,
          attemptCount,
        },
        update: {
          attemptCount,
          updatedAt: new Date(),
        },
      });
    } catch (dbErr) {
      cloudLog({
        severity: "ERROR",
        component: "System",
        action: `DLQ_${P}_DB_ERROR`,
        a2a_transfer: false,
        message: `Failed to write DLQ record: ${dbErr instanceof Error ? dbErr.message : String(dbErr)}`,
        businessId,
        data: { paymentIntentId, taskName },
      });
      // Return 500 so Pub/Sub retries — we want this persisted.
      return NextResponse.json({ ok: false, error: "db_error" }, { status: 500 });
    }

    // Surface in the critical-write audit trail so the ops dashboard shows it.
    await recordCriticalWriteEvent({
      client: prisma,
      businessId,
      actorUserId: "system-cloud-tasks-dlq",
      actorEmployeeId: null,
      routeScope: "internal",
      actionType: opts.actionType,
      resourceType: "PaymentIntent",
      resourceId: paymentIntentId,
      summary: `Cloud Tasks DLQ: ${opts.queueName} exhausted retries (${attemptCount} attempts)`,
      payload: { paymentIntentId, taskName, attemptCount },
    }).catch(() => {
      // Best-effort — DLQ record is already persisted; audit failure is non-fatal.
    });

    return NextResponse.json({ ok: true });
  };
}
