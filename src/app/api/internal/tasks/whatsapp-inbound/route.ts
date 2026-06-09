// POST /api/internal/tasks/whatsapp-inbound — Cloud Tasks worker.
//
// Receives the task payload enqueued by /api/whatsapp/webhook and runs the
// Customer Agent + outbound reply synchronously. The webhook returns 200 in
// <1s after enqueue so Twilio/Meta never hit their ~15s webhook timeout.
//
// Auth: OIDC token (canonical, Google 2026) with shared-secret fallback for
// the 1-deploy migration window. SA-pinning + audience check live in
// _lib/verify-oidc-token.ts (mirror of confirm-payment's helper).
//
// Industry-standard async webhook pattern:
//   Twilio:  https://www.twilio.com/en-us/blog/handle-long-running-asynchronous-operations-studio
//   Stripe:  https://stripe.com/docs/webhooks/best-practices#acknowledge-events-immediately
//   GCP:     https://cloud.google.com/run/docs/triggering/using-tasks
//
// Retry behaviour: 500 for transient errors → Cloud Tasks retries with the
// queue's configured backoff. 200 for terminal states (resolver returns null,
// already-handled) so Cloud Tasks does not retry.
//
// Idempotency: named task `wpp-inbound-{messageId}` dedupes at enqueue time
// (Cloud Tasks 1h-24h window). Repeated runs of the same task call the
// Customer Agent twice — acceptable because the agent's tool side-effects
// (customer upsert, payment intent create) are themselves idempotent.

import { NextRequest, NextResponse } from "next/server";
import { cloudLog, runWithTraceContext } from "@/lib/cloud-logger";
import { prisma } from "@/lib/prisma";
import { normalizeCustomerName } from "@/lib/normalize";
import { normalizePhone, sendTypingIndicator } from "@/lib/whatsapp-meta";
import { runCustomerAgent } from "@/lib/adk/customer-agent";
import { sendCustomerAgentReply } from "@/app/api/whatsapp/_lib/customer-reply";
import { verifyOidcToken } from "./_lib/verify-oidc-token";
import { timingSafeEqualStr } from "@/app/api/internal/_lib/oidc-verifiers";
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Prisma client regen blocked on Windows DLL lock; Cloud Build runs prisma generate fresh so prod runtime has ChatMessage.customerId.
const db = prisma as any;

// maxDuration raised to 100s: Customer Agent ADK budget is 90s
// (CUSTOMER_AGENT_ADK_TIMEOUT_MS=90000) + 10s margin for customer upsert,
// ChatMessage persist, and outbound reply. Deadline Propagation (Google SRE
// Book): outer route must exceed inner budget.
// Hierarchy: route maxDuration (100) ≥ dispatch budget (100) ≥ ADK (90). ✓
export const maxDuration = 100;

const CLOUD_TASKS_QUEUE_HEADER = "x-cloudtasks-queuename";
const TASK_SECRET_HEADER = "x-velora-task-secret";
const EXPECTED_SECRET = process.env.CRON_SECRET ?? "";

interface TaskPayload {
  provider: "meta" | "twilio";
  businessId: string;
  from: string;
  text: string;
  messageId: string;
}

function isTaskPayload(v: unknown): v is TaskPayload {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    (o.provider === "meta" || o.provider === "twilio") &&
    typeof o.businessId === "string" &&
    typeof o.from === "string" &&
    typeof o.text === "string" &&
    typeof o.messageId === "string"
  );
}

async function handlePost(req: NextRequest): Promise<NextResponse> {
  const t0 = Date.now(); // #1 per-turn latency stamp (Google SRE golden signal: measure user-facing latency)
  const authHeader = req.headers.get("authorization");
  const secret = req.headers.get(TASK_SECRET_HEADER) ?? "";
  const queueHeader = req.headers.get(CLOUD_TASKS_QUEUE_HEADER) ?? "";

  const oidcValid = await verifyOidcToken(authHeader);
  const secretValid = timingSafeEqualStr(secret, EXPECTED_SECRET);

  if (!oidcValid && !secretValid) {
    cloudLog({
      severity: "CRITICAL",
      component: "WhatsApp",
      action: "TASK_WPP_AUTH_FAILED",
      a2a_transfer: false,
      message: "whatsapp-inbound task auth failed — neither OIDC nor shared secret matched",
    });
    return NextResponse.json({ ok: false, error: "auth_failed" }, { status: 403 });
  }

  // Defense-in-depth: Cloud Tasks injects X-CloudTasks-QueueName on every
  // delivery. Its absence means the caller bypassed the queue (possible if
  // an authenticated outsider calls the route directly). Fail-closed (400)
  // mirrors confirm-payment and cancel-payment.
  // Ref: https://cloud.google.com/tasks/docs/creating-http-target-tasks#handler
  if (!queueHeader) {
    cloudLog({
      severity: "WARNING",
      component: "WhatsApp",
      action: "TASK_WPP_NO_QUEUE_HEADER",
      a2a_transfer: false,
      message: "whatsapp-inbound: missing X-CloudTasks-QueueName header — rejecting (fail-closed)",
    });
    // Return 400 so Cloud Tasks routes this to DLQ for ops inspection.
    // Ref: https://cloud.google.com/tasks/docs/reference/rest/v2/projects.locations.queues#RetryConfig
    return NextResponse.json({ ok: false, error: "missing_queue_header" }, { status: 400 });
  }

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  if (!isTaskPayload(payload)) {
    return NextResponse.json({ ok: false, error: "invalid_payload" }, { status: 400 });
  }

  const { provider, businessId, text, messageId } = payload;

  // Normalize sender phone to canonical E.164 at the single entry-point so every
  // consumer below (Customer upsert, runCustomerAgent userId, sendCustomerAgentReply)
  // sees the same "+<digits>" form.
  // Root cause (2026-05-29): Meta Cloud API delivers bare digits ("5491190000000");
  // Twilio delivers "+"-prefixed ("+5491190000000"). StatefulCustomerSessionService
  // .getSession branches on userId.startsWith("+") — bare-digits Meta phones missed
  // the branch → super.getSession → no pre-created session found → ADK threw
  // "Session not found". normalizePhone handles both inputs idempotently.
  // NOTE: Customer rows that were stored with bare-digit phones (before this fix)
  // will NOT be found on the first turn after deploy — a fresh normalized row is
  // created. Conversation history is lost for those customers for one turn (the
  // agent still works). Run a migration backfill to canonicalize bare-digit phones.
  // Source: https://www.twilio.com/docs/glossary/what-e164 (E.164, 2026)
  let from: string;
  try {
    from = normalizePhone(payload.from);
  } catch {
    // Malformed phone — cannot resolve customer or send reply. Log and return 200
    // (not 500) so Cloud Tasks does not retry an inherently undeliverable message.
    cloudLog({
      severity: "WARNING",
      component: "WhatsApp",
      action: "TASK_WPP_INVALID_PHONE",
      a2a_transfer: false,
      message: `Dropping task — could not normalize sender phone to E.164`,
      data: { provider, businessId, rawFrom: payload.from, messageId },
    });
    return NextResponse.json({ ok: false, error: "invalid_phone" }, { status: 200 });
  }

  cloudLog({
    severity: "INFO",
    component: "WhatsApp",
    action: "TASK_WPP_PROCESS_START",
    a2a_transfer: false,
    message: `Processing wpp inbound from=${from} messageId=${messageId}`,
    data: { provider, businessId, from, messageId },
  });

  // #2 perceived latency: show "escribiendo…" immediately so the multi-second
  // checkout chain doesn't read as a hang. Fire-and-forget (Meta-only).
  if (provider === "meta") void sendTypingIndicator(businessId, messageId).catch(() => undefined);

  try {
    // 1. Resolve or create the customer by (businessId, phone) so we have a
    //    stable thread anchor BEFORE the agent runs.
    //    NOTE: Customer_businessId_phone_unique partial index EXISTS on (businessId, phone)
    //    WHERE phone IS NOT NULL (migration 20260525940000_customer_phone_unique).
    //    The comment "no composite on phone" in the original code was wrong — the
    //    partial index was added later. We cannot use Prisma upsert (schema @@unique
    //    is on (businessId, name), not phone) but we can catch P2002 on create.
    //    On a Cloud Tasks retry race, findFirst may return null on both instances
    //    simultaneously, both attempt create, one wins, the other gets P2002. Fix:
    //    catch P2002 and re-fetch the winner row.
    let customer: { id: string } | null = await db.customer.findFirst({
      where: { businessId, phone: from },
      select: { id: true },
    });
    if (!customer) {
      // Normalize the name so the phone string goes through the canonical
      // customer-name pipeline (trim, title-case) matching createCustomerInTransaction.
      const name = normalizeCustomerName(from) || from;
      try {
        customer = (await db.customer.create({
          data: { businessId, phone: from, name },
          select: { id: true },
        })) as { id: string };
      } catch (createErr) {
        // P2002 = Prisma unique constraint violation — concurrent retry won the race.
        // Re-fetch the row the winning instance created.
        const isP2002 =
          createErr instanceof Error &&
          (createErr as { code?: string }).code === "P2002";
        if (isP2002) {
          customer = (await db.customer.findFirst({
            where: { businessId, phone: from },
            select: { id: true },
          })) as { id: string } | null;
        }
        if (!customer) throw createErr;
      }
    }
    const customerId: string = customer.id;

    // 2. Persist the inbound customer message BEFORE the agent runs so the
    //    Customer Agent's sessionService loads it as a previous turn on the
    //    NEXT request. clientMessageId mirrors the Twilio/Meta SID so the
    //    @@unique([businessId, clientMessageId]) gives free retry dedup.
    //    Source (verified HTTP 200 2026-05-28):
    //      https://google.github.io/adk-docs/sessions/session/
    //      https://google.github.io/adk-docs/sessions/state/
    await db.chatMessage.upsert({
      where: { businessId_clientMessageId: { businessId, clientMessageId: `wpp-in-${messageId}` } },
      update: {},
      create: {
        businessId,
        customerId,
        clientMessageId: `wpp-in-${messageId}`,
        kind: "text",
        source: "customer",
        text: text.slice(0, 8192),
      },
    }).catch(() => undefined);

    // 3. Run the Customer Agent DIRECTLY (skip the A2A self-call hop — the
    //    OIDC-authenticated worker is internally trusted; the A2A jsonrpc
    //    endpoint remains for external Supervisor delegation flows).
    //    The agent uses the canonical Runner + ChatMessageSessionService so
    //    previous turns load automatically via getSession(userId=phone) — no
    //    need to pass history through the call.
    // C1 fix: pass messageId so runCustomerAgent can exclude the wpp-in-{messageId}
    // ChatMessage from session history — that row was just written above and must
    // not appear a second time as a history event (the runner adds it via newMessage).
    const result = await runCustomerAgent({
      businessId,
      customerPhone: from,
      text,
      inboundMessageId: messageId,
    });

    // 4. Persist agent reply so the next turn loads it as session context.
    if (result.text) {
      await db.chatMessage.upsert({
        where: { businessId_clientMessageId: { businessId, clientMessageId: `wpp-out-${messageId}` } },
        update: {},
        create: {
          businessId,
          customerId,
          clientMessageId: `wpp-out-${messageId}`,
          kind: "text",
          source: "customer_assistant",
          text: result.text.slice(0, 8192),
        },
      }).catch(() => undefined);

      // 6. Send the reply back via the same provider Twilio/Meta delivered on.
      await sendCustomerAgentReply({
        toPhoneE164: from,
        text: result.text,
        provider,
        businessId,
        messageId,
      });
    }

    cloudLog({
      severity: "INFO",
      component: "WhatsApp",
      action: "TASK_WPP_PROCESS_DONE",
      a2a_transfer: false,
      message: `Processed wpp inbound — reply ${result.text ? "sent" : "empty"} in ${Date.now() - t0}ms`,
      data: { provider, businessId, from, messageId, hasReply: !!result.text, latencyMs: Date.now() - t0 },
    });

    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (err) {
    cloudLog({
      severity: "ERROR",
      component: "WhatsApp",
      action: "TASK_WPP_PROCESS_ERROR",
      a2a_transfer: false,
      message: `whatsapp-inbound task failed: ${err instanceof Error ? err.message : String(err)}`,
      data: {
        provider,
        businessId,
        from,
        messageId,
        // Include stack trace + error type for diagnostic when prod minified
        // identifiers obscure the source (e.g. "r is not a function" 2026-05-28).
        errName: err instanceof Error ? err.name : typeof err,
        errStack: err instanceof Error ? err.stack?.slice(0, 4000) : undefined,
      },
    });
    // 500 → Cloud Tasks retries with configured backoff.
    return NextResponse.json({ ok: false, error: "process_failed" }, { status: 500 });
  }
}

export function POST(req: NextRequest): Promise<NextResponse> {
  return runWithTraceContext(req.headers, () => handlePost(req));
}
