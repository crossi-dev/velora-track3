// POST /api/internal/agents/payment-link-sale
//
// Internal endpoint: runs registerSaleWithPaymentLinkUseCase on behalf of the
// Payments agent — replacing its direct in-process call with an HTTP call to
// core (Phase 2 Payments — agent-to-core HTTP, not direct DB).
//
// Auth: shared CRON_SECRET bearer token — same pattern as S4 (shipments) and
// S5 (invoice-cae). Timing-safe comparison prevents constant-time oracle attacks.
//
// Why not OIDC here: the caller is the Payments ADK agent tool. There is no
// SA-pinned OIDC token available in that tool-execution context. CRON_SECRET
// bearer is the correct internal-service-to-service mechanism already established.
//
// Allowlist: /api/internal/agents/payment-link-sale is added to API_ALLOWLIST
// in middleware.ts (explicit per-endpoint entry, same pattern as shipments and
// invoice-cae).
//
// Response contract (money-critical): every business outcome is returned as
// HTTP 200 with the full RegisterSaleWithPaymentLinkResult JSON — the agent
// interprets result.outcome. Only auth failure → 401 and malformed/missing
// fields → 400. A 5xx from this handler means an unexpected throw escaped the
// use-case — the agent's existing error path handles it identically to today's
// in-process throw.
//
// Idempotency: the use-case uses beginIdempotentMutation (Brandur insert-first
// pattern). An HTTP timeout AFTER the transaction commits, retried with the
// same idempotencyKey, returns { outcome: "replayed" } — no double sale.
// This is WHY the HTTP cutover is safe: retries are idempotent.
//
// Tenant isolation: input.businessId scopes every DB read/write inside the
// use-case — same isolation as the in-process path.
//
// Guardrail note: payment_intent.create_link is listed in SUPERVISOR_INTERNAL_ACTIONS
// in check-server-mutation-contract.mjs — the required contract calls
// (recordCriticalWriteEvent + beginIdempotentMutation/completeIdempotentMutation/
// releaseIdempotentMutation) live inside registerSaleWithPaymentLinkUseCase,
// which this endpoint calls as a thin transport wrapper. Same orphan-server-entry
// pattern as shipment.create (Andreani agent). The guardrail check does NOT scan
// this route for those calls — they live inside the use-case already.

import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { cloudLog } from "@/lib/cloud-logger";
import { registerSaleWithPaymentLinkUseCase } from "@/app/api/payment-intents/_lib/register-sale-with-payment-link-use-case";
import type { RegisterSaleWithPaymentLinkInput } from "@/app/api/payment-intents/_lib/register-sale-with-payment-link-use-case";

const EXPECTED_SECRET = process.env.CRON_SECRET ?? "";

function timingSafeEqualStr(a: string, b: string): boolean {
  try {
    return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
  } catch {
    return false;
  }
}

function verifyBearer(authHeader: string | null): boolean {
  if (!authHeader?.startsWith("Bearer ")) return false;
  if (!EXPECTED_SECRET) return false;
  return timingSafeEqualStr(authHeader.slice(7), EXPECTED_SECRET);
}

const REQUIRED_FIELDS = [
  "businessId",
  "actorUserId",
  "customerId",
  "items",
  "description",
  "idempotencyKey",
] as const;

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!verifyBearer(req.headers.get("authorization"))) {
    cloudLog({
      severity: "WARNING",
      component: "A2A",
      action: "PAYMENT_LINK_SALE_WRITEBACK_AUTH_FAILED",
      a2a_transfer: false,
      message: "payment-link-sale: unauthorized request — bearer mismatch or missing",
    });
    return NextResponse.json(
      { code: "UNAUTHORIZED", message: "Authentication required." },
      { status: 401 },
    );
  }

  let body: RegisterSaleWithPaymentLinkInput;
  try {
    body = (await req.json()) as RegisterSaleWithPaymentLinkInput;
  } catch {
    return NextResponse.json(
      { code: "BAD_REQUEST", message: "Invalid JSON body." },
      { status: 400 },
    );
  }

  for (const field of REQUIRED_FIELDS) {
    const value = body[field];
    const isEmpty =
      value === undefined ||
      value === null ||
      value === "" ||
      (field === "items" && Array.isArray(value) && value.length === 0);
    if (isEmpty) {
      return NextResponse.json(
        {
          code: "BAD_REQUEST",
          message: `Missing required field: ${field}.`,
        },
        { status: 400 },
      );
    }
  }

  cloudLog({
    severity: "INFO",
    component: "A2A",
    action: "PAYMENT_LINK_SALE_WRITEBACK_START",
    a2a_transfer: false,
    message: "payment-link-sale: invoking use-case via HTTP endpoint",
    data: { businessId: body.businessId, idempotencyKey: body.idempotencyKey, customerId: body.customerId },
  });

  const result = await registerSaleWithPaymentLinkUseCase(body);

  cloudLog({
    severity: "INFO",
    component: "A2A",
    action: "PAYMENT_LINK_SALE_WRITEBACK_DONE",
    a2a_transfer: false,
    message: `payment-link-sale: use-case returned outcome=${result.outcome}`,
    data: { businessId: body.businessId, outcome: result.outcome },
  });

  return NextResponse.json(result, { status: 200 });
}
