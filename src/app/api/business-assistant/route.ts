// maxDuration 90s: JS guard (LLM_TIMEOUT_MS=80s) fires first with 504;
// platform hard kill stays at 300s. Ref: cloud.google.com/run/docs/configuring/request-timeout
export const maxDuration = 90;

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { loadBusinessAssistantContext } from "./_lib/context";
import { checkRateLimitAsync, bypassIfTester } from "@/app/api/_lib/route-helpers";
import { checkAiRateLimit, checkAiPerMinuteLimit } from "@/app/api/_lib/ai-rate-limit";
import { isDemoBusiness } from "@/lib/demo-business";
import { createAssistantTrace } from "./_lib/trace";
import {
  beginIdempotentMutation,
  completeIdempotentMutation,
  releaseIdempotentMutation,
  getIdempotencyKey,
} from "@/app/api/_lib/idempotency";
import { resolveActor } from "@/app/api/_lib/resolve-actor";
import { checkAndIncrementOwnerChatQuota, buildQuotaExhaustedResponse } from "@/app/api/_lib/owner-chat-quota";
import { publishChatMessage } from "@/app/api/_lib/agent-event-publishers";
import { handleAssistantRouteError } from "./_lib/error-handler";
import { handleOwnerTurn } from "./_lib/owner-handler";
import { handleEmployeeTurn } from "./_lib/employee-handler";
import { cloudLog, runWithTraceContext } from "@/lib/cloud-logger";
import { runWithTenantContext } from "@/lib/tenant-context";
import { createLatencyTracker } from "./_lib/latency-tracker";

import { patchEmptyAnswer, buildHandleStreamingPost, type HandlePostFn } from "./_lib/route-streaming";
import { buildRecentHistory } from "./_lib/route-history-filter";
import {
  deriveUserClientMessageId,
  deriveReplyClientMessageId,
  scheduleUserInputPersist,
  scheduleReplyPersist,
} from "./_lib/chat-persist";
import { runPolishIntercept, attachOwnerReadWidget } from "./_lib/route-polish-intercept";

// LLM_TIMEOUT_MS races handlePost; fires before Cloud Run 300s kill → clean 504.
// Default 40s: supervisor(26s) + DB context(~10s) = 36s budget. Override via env.
const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS ?? "40000");

const ASSISTANT_CHAT_ACTION = "assistant.chat";

// Built lazily after handlePost is defined below.
let _handleStreamingPost: ((req: NextRequest) => Promise<Response>) | null = null;
function getStreamingHandler() {
  if (!_handleStreamingPost) {
    // C2 fix (Finding 2): HandlePostFn now accepts an optional preReadBuffer so the
    // streaming wrapper can buffer req.body once and pass it in, preventing a double-read
    // if the platform already consumed the stream before handlePost runs.
    _handleStreamingPost = buildHandleStreamingPost(handlePost as HandlePostFn, LLM_TIMEOUT_MS);
  }
  return _handleStreamingPost;
}

export async function POST(req: NextRequest) {
  if (req.headers.get("Accept")?.includes("text/event-stream")) {
    return getStreamingHandler()(req);
  }
  // HIGH-3-2: capture handle to clear it when handlePost wins (no 40s closure leak).
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<NextResponse>((resolve) => {
    timeoutHandle = setTimeout(
      () => resolve(NextResponse.json({ code: "GATEWAY_TIMEOUT", message: "Request timed out. Please try again." }, { status: 504 })),
      LLM_TIMEOUT_MS,
    );
  });
  const result = await Promise.race([
    runWithTraceContext(req.headers, () => handlePost(req)),
    timeoutPromise,
  ]);
  if (timeoutHandle !== null) clearTimeout(timeoutHandle);
  return result;
}

// 512 KB cap: 12 turns × 1500 chars + prompt + metadata. DoS protection.
const CHAT_MAX_BODY_BYTES = 512 * 1024;

interface AssistantRequestBody {
  text?: unknown;
  locale?: unknown;
  lang?: unknown;
  activeInvoiceId?: unknown;
  latestPurchaseRequestId?: unknown;
  latestPurchaseRequestNumber?: unknown;
  chatHistory?: unknown;
}

// C2 fix (Finding 2): preReadBuffer from SSE entry — buffers body once, avoids double-read.
// Ref: nextjs.org/docs/app/api-reference/functions/next-request
async function handlePost(req: NextRequest, preReadBuffer?: ArrayBuffer) {
  // SEC-BODY-1: arrayBuffer() — content-length is attacker-controlled on chunked TE (next.js#15721).
  let rawBuffer: ArrayBuffer;
  if (preReadBuffer !== undefined) {
    rawBuffer = preReadBuffer;
  } else {
    try {
      rawBuffer = await req.arrayBuffer();
    } catch {
      return NextResponse.json({ code: "INVALID_REQUEST", message: "Invalid request body." }, { status: 400 });
    }
  }
  if (rawBuffer.byteLength > CHAT_MAX_BODY_BYTES) {
    return NextResponse.json({ code: "PAYLOAD_TOO_LARGE", message: "Request body too large." }, { status: 413 });
  }

  // Resolve actor first so we can pass isTester to all three rate-limit layers.
  const ctx = await resolveActor(req);
  if (!ctx) return NextResponse.json({ code: "UNAUTHORIZED", message: "Authentication required." }, { status: 401 });

  const bypass = bypassIfTester(ctx);

  const rateLimited = await checkRateLimitAsync(req, "ai", 30, 60, bypass);
  if (rateLimited) return rateLimited;

  // AI limiters skipped for demo businesses (DEMO_BUSINESS_IDS); enforced for all others.
  if (!isDemoBusiness(ctx.businessId)) {
    if (!(await checkAiPerMinuteLimit(ctx.actorUserId)))
      return NextResponse.json({ code: "RATE_LIMITED", message: "Too many requests. Please wait a moment." }, { status: 429 });
    if (!(await checkAiRateLimit(ctx.actorUserId)))
      return NextResponse.json({ code: "DAILY_LIMIT_REACHED", message: "Daily request limit reached. Try again tomorrow." }, { status: 429 });
  }

  const biz = await prisma.business.findUnique({ where: { id: ctx.businessId }, select: { id: true } });
  if (!biz) return NextResponse.json({ code: "BUSINESS_NOT_FOUND", message: "No business found for this user." }, { status: 404 });

  const latency = createLatencyTracker(ctx.role === "owner" ? "owner" : "employee");

  // C2 fix (Finding 5): hoist for finally block. LatencyTracker guards double-emits.
  const latencyEmitArgs = { businessId: biz.id, actorUserId: ctx.actorUserId, actorEmployeeId: ctx.actorEmployeeId };

  let body: AssistantRequestBody;
  try {
    body = JSON.parse(new TextDecoder().decode(rawBuffer)) as AssistantRequestBody;
  } catch {
    return NextResponse.json({ code: "INVALID_REQUEST", message: "Invalid request body." }, { status: 400 });
  }

  let idempotencyRecordId: string | null = null; // hoisted for catch-block release
  // RLS-1: tenant context for DB isolation; inert until RLS_SESSION_CONTEXT_ENABLED=true.
  try { return await runWithTenantContext(biz.id, async () => {
    const trace = createAssistantTrace();
    const { text: rawText, locale: rawLocale, lang: rawLang, activeInvoiceId: rawActiveInvoiceId, latestPurchaseRequestId: rawLatestPurchaseRequestId, latestPurchaseRequestNumber: rawLatestPurchaseRequestNumber, chatHistory } = body;
    const businessId = biz.id;
    const actorEmployeeId = ctx.actorEmployeeId;

    const text: string = typeof rawText === "string" ? rawText.slice(0, 1000) : "";
    const locale = typeof rawLocale === "string" ? rawLocale : null;
    const lang: "en" | "es-AR" = rawLang === "en" ? "en" : "es-AR";
    const latestPurchaseRequestNumber = typeof rawLatestPurchaseRequestNumber === "string" ? rawLatestPurchaseRequestNumber : undefined;
    if (!text) return NextResponse.json({ code: "MISSING_TEXT", message: "Request text is required." }, { status: 400 });

    // C1: X-Idempotency-Key → shared clientMessageId → P2002 dedup (ai-sdk.dev/docs/ai-sdk-ui/chatbot-message-persistence).
    const idempotencyKey = getIdempotencyKey(req);
    const serverClientMessageId = deriveUserClientMessageId({
      idempotencyKey, businessId, actorUserId: ctx.actorUserId, text,
    });

    const inboundEventId = await publishChatMessage({
      businessId,
      actorEmployeeId,
      text,
      locale,
      actorRole: ctx.role === "owner" ? "owner" : "employee",
      clientMessageId: null,
    });

    const actorRole = ctx.role === "owner" ? "owner" : "employee";
    if (idempotencyKey) {
      try {
        const gate = await beginIdempotentMutation({
          client: prisma, businessId, actionType: ASSISTANT_CHAT_ACTION,
          idempotencyKey, requestBody: { text, locale: locale ?? null }, req,
        });
        if (gate.kind === "replay") return gate.response;
        if (gate.kind === "in_flight" || gate.kind === "conflict") {
          return NextResponse.json({ code: "IN_FLIGHT", message: "This request is already being processed." }, { status: 409 });
        }
        if (gate.kind === "execute") {
          idempotencyRecordId = gate.recordId;
          await scheduleUserInputPersist({ gateKind: "execute", businessId, actorUserId: ctx.actorUserId, role: actorRole, clientMessageId: serverClientMessageId, text });
        }
      } catch (idempErr) {
        await scheduleUserInputPersist({ gateKind: "gate_error", businessId, actorUserId: ctx.actorUserId, role: actorRole, clientMessageId: serverClientMessageId, text });
        cloudLog({ severity: "WARNING", component: "System", action: "IDEMPOTENCY_GATE_FAILED", a2a_transfer: false, message: "idempotency gate unavailable, falling back", businessId, data: { error: idempErr instanceof Error ? idempErr.message : String(idempErr) } });
      }
    } else {
      await scheduleUserInputPersist({ gateKind: "no_key", businessId, actorUserId: ctx.actorUserId, role: actorRole, clientMessageId: serverClientMessageId, text });
    }

    // C2 fix (Finding 4): shared finalise — both respond() and cacheAndReturn() run through here.
    // Obligations: (1) completeIdempotentMutation, (2) scheduleReplyPersist, (3) latency.emit().
    const finalisePost = async (finalResponse: NextResponse, respBody: Record<string, unknown>, responseStatus: number) => {
      let resp = finalResponse;
      if (idempotencyRecordId) {
        try {
          await completeIdempotentMutation({ client: prisma, recordId: idempotencyRecordId, responseStatus, responseBody: respBody });
        } catch (cacheErr) {
          cloudLog({ severity: "WARNING", component: "System", action: "IDEMPOTENCY_COMPLETE_FAILED", a2a_transfer: false, message: "idempotency complete failed", businessId, data: { error: cacheErr instanceof Error ? cacheErr.message : String(cacheErr) } });
        }
      }
      if (typeof respBody.answer === "string" && respBody.answer) {
        const replyId = deriveReplyClientMessageId(serverClientMessageId);
        await scheduleReplyPersist({ businessId, clientMessageId: replyId, answer: respBody.answer, chips: respBody.chips ?? undefined });
        if (responseStatus >= 200 && responseStatus < 300) { respBody.replyClientMessageId = replyId; resp = NextResponse.json(respBody, { status: responseStatus }); }
      }
      try { latency.emit(latencyEmitArgs); } catch { /* best-effort */ }
      return resp;
    };

    const respond = async (rawBody: Record<string, unknown>, status = 200) => {
      const patched = await patchEmptyAnswer(NextResponse.json(rawBody, { status }), businessId, text);
      const initialBody = status >= 200 && status < 300 ? ((await patched.clone().json()) as Record<string, unknown>) : rawBody;
      const { respBody, finalResponse } = await runPolishIntercept(patched, initialBody, status, businessId);
      return attachOwnerReadWidget({ body: respBody, response: finalResponse, status, role: ctx.role, businessId, text, finalise: finalisePost });
    };

    // SEC-HIST-1: sanitize-then-slice extracted to route-history-filter.ts.
    // See that module for the full OWASP LLM Top 10 #1 2026 rationale.
    const recentHistory = buildRecentHistory(chatHistory);

    // Hoisted so both owner and employee paths can share the single persistence
    // gate. Owner deterministic fast-path uses this to funnel replies through
    // finalisePost (scheduleReplyPersist) — same gate the employee path uses.
    const cacheAndReturn = async (res: NextResponse) => {
      const patched = await patchEmptyAnswer(res, businessId, text);
      const cacheBody = (await patched.clone().json()) as Record<string, unknown>;
      return attachOwnerReadWidget({ body: cacheBody, response: patched, status: patched.status, role: ctx.role, businessId, text, finalise: finalisePost });
    };

    if (ctx.role === "owner") {
      // Free-tier daily cap. Fail-open on DB error — soft cost-protection, not a security gate.
      const quota = await checkAndIncrementOwnerChatQuota({
        businessId,
        isTester: ctx.isTester === true,
      });
      if (!quota.allowed) {
        cloudLog({
          severity: "INFO",
          component: "System",
          action: "OWNER_CHAT_QUOTA_EXHAUSTED",
          a2a_transfer: false,
          message: "Owner hit free daily chat cap — returning quota-exhausted response",
          businessId,
          data: { current: quota.current, limit: quota.limit, actorUserId: ctx.actorUserId },
        });
        // Route through respond/finalisePost so the quota message persists to chat history.
        return respond(buildQuotaExhaustedResponse(quota.remaining, quota.limit) as Record<string, unknown>);
      }
      return handleOwnerTurn({ text, lang, businessId, actorUserId: ctx.actorUserId, inboundEventId, respond, cacheAndReturn, trace, latency, recentHistory });
    }

    const auditCrossTenantRejection = (kind: "invoice" | "purchase_request", id: string, foundBusinessId: string | null) => {
      cloudLog({ severity: "WARNING", component: "RBAC", action: "CROSS_TENANT_ID_REJECTED", a2a_transfer: false, message: `Cross-tenant ${kind} id rejected: ${id}`, data: { kind, attemptedId: id, foundBusinessId, actorBusinessId: businessId }, businessId, actorUserId: ctx.actorUserId, actorEmployeeId: ctx.actorEmployeeId ?? undefined });
    };

    // C2 fix (Finding 6): validate both IDs in parallel (independent findUnique calls, no P2024 risk outside $transaction).
    // Ref: prisma.io/docs/orm/prisma-client/queries/transactions
    let activeInvoiceId: string | undefined = typeof rawActiveInvoiceId === "string" ? rawActiveInvoiceId : undefined;
    let latestPurchaseRequestId: string | undefined = typeof rawLatestPurchaseRequestId === "string" ? rawLatestPurchaseRequestId : undefined;

    if (activeInvoiceId || latestPurchaseRequestId) {
      const [invoiceRow, purchaseRequestRow] = await Promise.all([
        activeInvoiceId
          ? prisma.invoice.findUnique({ where: { id: activeInvoiceId }, select: { businessId: true } })
          : Promise.resolve(null),
        latestPurchaseRequestId
          ? prisma.purchaseRequest.findUnique({ where: { id: latestPurchaseRequestId }, select: { businessId: true } })
          : Promise.resolve(null),
      ]);

      if (activeInvoiceId && (!invoiceRow || invoiceRow.businessId !== businessId)) {
        auditCrossTenantRejection("invoice", activeInvoiceId, invoiceRow?.businessId ?? null);
        activeInvoiceId = undefined;
      }
      if (latestPurchaseRequestId && (!purchaseRequestRow || purchaseRequestRow.businessId !== businessId)) {
        auditCrossTenantRejection("purchase_request", latestPurchaseRequestId, purchaseRequestRow?.businessId ?? null);
        latestPurchaseRequestId = undefined;
      }
    }

    const loadedContext = await loadBusinessAssistantContext(businessId);
    if (!loadedContext) return respond({ code: "BUSINESS_NOT_FOUND", message: "Business not found." }, 404);

    return handleEmployeeTurn({
      text, locale, lang, businessId, actorEmployeeId, actorUserId: ctx.actorUserId,
      role: ctx.role, inboundEventId, respond, cacheAndReturn, trace, latency,
      recentHistory, loadedContext, activeInvoiceId, latestPurchaseRequestId,
      latestPurchaseRequestNumber,
    }); });
  } catch (error) {
    latency.setMeta("error", true);
    // Release idempotency record so retries are not blocked for 5 min.
    await releaseIdempotentMutation({ client: prisma, recordId: idempotencyRecordId });
    return handleAssistantRouteError(error, biz.id);
  } finally {
    // C2 fix (Finding 5): unconditional — fires on success, error, and SSE cancellation.
    try { latency.emit(latencyEmitArgs); } catch { /* best-effort */ }
  }
}
