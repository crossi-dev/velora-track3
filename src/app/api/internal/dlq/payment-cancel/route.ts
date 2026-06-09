// POST /api/internal/dlq/payment-cancel — Pub/Sub push subscriber for the
// velora-payment-cancel dead-letter topic.
//
// Cloud Tasks forwards exhausted cancel tasks to the DLQ Pub/Sub topic after
// max-attempts. Pub/Sub push delivers the message here via HTTPS. We record the
// failure in PaymentCancelDlq and fire recordCriticalWriteEvent so the audit
// trail surfaces it for ops replay.
//
// Every queue must have symmetric DLQ coverage — this mirrors payment-confirm DLQ
// exactly. A permanent cancel failure leaves a PI in pending state; without a DLQ
// record it is invisible to ops.
//
// Auth: Pub/Sub push uses a Google-signed OIDC token in the Authorization header.
// We verify it using google-auth-library (same pattern as the task worker).
// Ref: https://cloud.google.com/pubsub/docs/push#authentication_and_authorization
// Ref: https://cloud.google.com/tasks/docs/reference/rest/v2/projects.locations.queues#RetryConfig
// DLQ symmetry: https://sreschool.com/blog/dead-letter-queue-dlq/
//
// This route is allowlisted in middleware via /api/internal — no user session needed.

import { NextRequest, NextResponse } from "next/server";
import { runWithTraceContext } from "@/lib/cloud-logger";
import { prisma } from "@/lib/prisma";
import { buildDlqHandler } from "@/app/api/internal/_lib/dlq-handler-factory";

const handlePost = buildDlqHandler({
  audiencePath: "/api/internal/dlq/payment-cancel",
  actionPrefix: "CANCEL",
  queueName: "payment-cancel",
  actionType: "payment_cancel_dlq",
  dlqModel: prisma.paymentCancelDlq,
});

export function POST(req: NextRequest): Promise<NextResponse> {
  return runWithTraceContext(req.headers, () => handlePost(req));
}
