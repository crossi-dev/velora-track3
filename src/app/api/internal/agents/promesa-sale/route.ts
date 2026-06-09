// POST /api/internal/agents/promesa-sale
//
// Internal endpoint: runs registerPromesaSaleUseCase on behalf of the
// Payments agent — replacing its direct in-process call with an HTTP call to
// core (Phase 2 Payments — promesa-sale HTTP cutover, parallel to #71 pattern).
//
// Auth: shared CRON_SECRET bearer token — same pattern as payment-link-sale (S6),
// shipments (S4), and invoice-cae (S5). Timing-safe comparison prevents constant-time
// oracle attacks.
//
// Why not OIDC here: the caller is the Payments ADK agent tool. There is no
// SA-pinned OIDC token available in that tool-execution context. CRON_SECRET
// bearer is the correct internal-service-to-service mechanism already established.
//
// Allowlist: /api/internal/agents/promesa-sale is added to API_ALLOWLIST
// in middleware.ts (explicit per-endpoint entry, same pattern as payment-link-sale).
//
// Response contract (money-critical): every business outcome is returned as
// HTTP 200 with the full RegisterPromesaSaleResult JSON — the agent interprets
// result.outcome. Only auth failure → 401 and malformed/missing fields → 400.
// A 5xx from this handler means an unexpected throw escaped the use-case — the
// agent's existing error path handles it identically to today's in-process throw.
//
// Idempotency: the use-case derives idempotencyKey internally from
// (customerId, items, expectedAt) via buildIdempotencyKey (sha256 hash).
// An HTTP timeout AFTER the transaction commits, retried with the same inputs,
// produces the same key → use-case returns { outcome: "replayed" } — no double
// sale. Idempotency uses findFirst + P2002 catch (NOT beginIdempotentMutation —
// the promesa use-case manages its own DB-unique constraint directly).
//
// DIVERGENCE from payment-link-sale (handle carefully):
//   1. expectedAt is a Date in the input type but travels as an ISO string over
//      the wire. This endpoint reconstructs it: `new Date(body.expectedAt)` and
//      validates with isNaN(d.getTime()) → 400 on invalid date.
//   2. No idempotencyKey in the HTTP body — it is derived internally by the
//      use-case. REQUIRED_FIELDS omits idempotencyKey and description.
//   3. shipping is a nested JSON object (JSON-safe, no special handling needed).
//
// Guardrail note: payment_intent.register_promesa_sale is listed in
// SUPERVISOR_INTERNAL_ACTIONS in check-server-mutation-contract.mjs — the
// required contract calls (recordCriticalWriteEvent) live inside
// registerPromesaSaleUseCase, which this endpoint calls as a thin transport
// wrapper. Same orphan-server-entry pattern as shipment.create and
// payment-link-sale. The guardrail check does NOT scan this route for those
// calls — they live inside the use-case already.
//
// Tenant isolation: input.businessId scopes every DB read/write inside the
// use-case — same isolation as the in-process path.

import { NextRequest, NextResponse } from "next/server";
import { cloudLog } from "@/lib/cloud-logger";
import { timingSafeEqualStr } from "@/app/api/internal/_lib/oidc-verifiers";
import { registerPromesaSaleUseCase } from "@/app/api/payment-intents/_lib/register-promesa-sale-use-case";
import type { RegisterPromesaSaleInput } from "@/app/api/payment-intents/_lib/register-promesa-sale-use-case";

const EXPECTED_SECRET = process.env.CRON_SECRET ?? "";

function verifyBearer(authHeader: string | null): boolean {
  if (!authHeader?.startsWith("Bearer ")) return false;
  if (!EXPECTED_SECRET) return false;
  return timingSafeEqualStr(authHeader.slice(7), EXPECTED_SECRET);
}

// No idempotencyKey — the use-case derives it internally from (customerId, items, expectedAt).
const REQUIRED_FIELDS = [
  "businessId",
  "actorUserId",
  "customerId",
  "items",
  "expectedAt",
] as const;

// Wire shape received over HTTP: same as RegisterPromesaSaleInput but expectedAt
// is an ISO string (JSON.stringify serialises Date → string). Reconstructed below.
type PromesaSaleBody = Omit<RegisterPromesaSaleInput, "expectedAt"> & {
  expectedAt: string;
};

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!verifyBearer(req.headers.get("authorization"))) {
    cloudLog({
      severity: "WARNING",
      component: "A2A",
      action: "PROMESA_SALE_WRITEBACK_AUTH_FAILED",
      a2a_transfer: false,
      message: "promesa-sale: unauthorized request — bearer mismatch or missing",
    });
    return NextResponse.json(
      { code: "UNAUTHORIZED", message: "Authentication required." },
      { status: 401 },
    );
  }

  let body: PromesaSaleBody;
  try {
    body = (await req.json()) as PromesaSaleBody;
  } catch {
    return NextResponse.json(
      { code: "BAD_REQUEST", message: "Invalid JSON body." },
      { status: 400 },
    );
  }

  for (const field of REQUIRED_FIELDS) {
    const value = body[field as keyof PromesaSaleBody];
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

  // DIVERGENCE 1 — reconstruct expectedAt Date from ISO string.
  // JSON serialisation turns Date → ISO string; the use-case requires a Date.
  // Validate before calling the use-case — an invalid date string would produce
  // a silent NaN-based idempotency key, corrupting the promesa's payment date.
  const expectedAtDate = new Date(body.expectedAt);
  if (isNaN(expectedAtDate.getTime())) {
    return NextResponse.json(
      {
        code: "BAD_REQUEST",
        message: `Invalid expectedAt: '${body.expectedAt}' is not a valid ISO date.`,
      },
      { status: 400 },
    );
  }

  cloudLog({
    severity: "INFO",
    component: "A2A",
    action: "PROMESA_SALE_WRITEBACK_START",
    a2a_transfer: false,
    message: "promesa-sale: invoking use-case via HTTP endpoint",
    data: { businessId: body.businessId, customerId: body.customerId, expectedAt: body.expectedAt },
  });

  const result = await registerPromesaSaleUseCase({
    ...body,
    expectedAt: expectedAtDate,
  });

  cloudLog({
    severity: "INFO",
    component: "A2A",
    action: "PROMESA_SALE_WRITEBACK_DONE",
    a2a_transfer: false,
    message: `promesa-sale: use-case returned outcome=${result.outcome}`,
    data: { businessId: body.businessId, outcome: result.outcome },
  });

  return NextResponse.json(result, { status: 200 });
}
