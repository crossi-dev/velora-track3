// PATCH /api/internal/agents/invoice-cae
//
// Internal endpoint: persists ARCA/WSFE CAE fields on an Invoice row on behalf
// of the Fiscal agent — replacing its direct Prisma write with an HTTP call to
// core (Phase 2 S5 — agent-to-core HTTP, not direct DB).
//
// Auth: shared CRON_SECRET bearer token — same pattern as the Andreani shipment
// writeback endpoint (src/app/api/internal/agents/shipments/route.ts, Phase 2 S4).
// Timing-safe comparison prevents constant-time oracle attacks.
//
// Why not OIDC here: the caller is the Fiscal agent's ADK tool. There is no
// SA-pinned OIDC token available in that tool-execution context. CRON_SECRET
// bearer is the correct internal-service-to-service mechanism already established.
//
// Allowlist: /api/internal/agents/invoice-cae is added to API_ALLOWLIST in
// middleware.ts (explicit per-endpoint entry, same pattern as biz-snapshot and
// shipments).
//
// Failure contract (fiscal-critical): a non-2xx from this handler means WSFE
// emitted the CAE at ARCA but it was NOT persisted in Velora — that is a legal
// compliance gap. The handler logs ERROR on every failure path. The HTTP client
// (cae-writeback.ts) throws a hard-stop FiscalCaeWritebackError on any failure.
//
// Tenant isolation: update is scoped by invoiceId + businessId (updateMany) — a
// foreign-tenant invoiceId returns count=0 → 404, no cross-tenant write.

import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { cloudLog } from "@/lib/cloud-logger";
import { prismaInvoiceRepository } from "@/infrastructure/persistence/prisma-invoice.repository";

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

interface CaePatchBody {
  businessId: string;
  invoiceId: string;
  caeCode: string;
  /** ISO 8601 string or null — rehydrated to Date before DB write. */
  caeFchVto: string | null;
  fiscalTipo: number | null;
  fiscalPtoVta: number | null;
  fiscalNumero: number;
  /** ISO 8601 string — rehydrated to Date before DB write. */
  fiscalEmittedAt: string;
  fiscalQrUrl: string | null;
}

export async function PATCH(req: NextRequest): Promise<NextResponse> {
  if (!verifyBearer(req.headers.get("authorization"))) {
    cloudLog({
      severity: "WARNING",
      component: "Fiscal",
      action: "INVOICE_CAE_WRITEBACK_AUTH_FAILED",
      a2a_transfer: false,
      message: "invoice-cae: unauthorized request — bearer mismatch or missing",
    });
    return NextResponse.json(
      { code: "UNAUTHORIZED", message: "Authentication required." },
      { status: 401 },
    );
  }

  let body: CaePatchBody;
  try {
    body = (await req.json()) as CaePatchBody;
  } catch {
    return NextResponse.json(
      { code: "BAD_REQUEST", message: "Invalid JSON body." },
      { status: 400 },
    );
  }

  const {
    businessId,
    invoiceId,
    caeCode,
    caeFchVto,
    fiscalTipo,
    fiscalPtoVta,
    fiscalNumero,
    fiscalEmittedAt,
    fiscalQrUrl,
  } = body;

  if (!businessId || !invoiceId || !caeCode || fiscalNumero == null || !fiscalEmittedAt) {
    return NextResponse.json(
      {
        code: "BAD_REQUEST",
        message:
          "Missing required field(s): businessId, invoiceId, caeCode, fiscalNumero, fiscalEmittedAt.",
      },
      { status: 400 },
    );
  }

  const caeFchVtoDate = caeFchVto ? new Date(caeFchVto) : null;
  if (caeFchVto && caeFchVtoDate && isNaN(caeFchVtoDate.getTime())) {
    return NextResponse.json(
      { code: "BAD_REQUEST", message: "caeFchVto must be a valid ISO 8601 date string." },
      { status: 400 },
    );
  }

  const fiscalEmittedAtDate = new Date(fiscalEmittedAt);
  if (isNaN(fiscalEmittedAtDate.getTime())) {
    return NextResponse.json(
      { code: "BAD_REQUEST", message: "fiscalEmittedAt must be a valid ISO 8601 date string." },
      { status: 400 },
    );
  }

  const result = await prismaInvoiceRepository.persistCaeFields({
    businessId,
    invoiceId,
    caeCode,
    caeFchVto: caeFchVtoDate,
    fiscalTipo: fiscalTipo ?? null,
    fiscalPtoVta: fiscalPtoVta ?? null,
    fiscalNumero,
    fiscalEmittedAt: fiscalEmittedAtDate,
    fiscalQrUrl: fiscalQrUrl ?? null,
  });

  if (!result.persisted) {
    // persistCaeFields already logged the ERROR (no-match or DB error). The
    // 404 here tells the HTTP client that the write did not land — it will
    // throw FiscalCaeWritebackError so the caller surfaces the compliance gap.
    cloudLog({
      severity: "ERROR",
      component: "Fiscal",
      action: "INVOICE_CAE_WRITEBACK_NO_PERSIST",
      a2a_transfer: false,
      message:
        "invoice-cae: persistCaeFields returned persisted=false — invoiceId/businessId mismatch or DB error",
      data: { invoiceId, businessId, caeCode },
    });
    return NextResponse.json(
      { code: "NOT_FOUND", message: "Invoice not found or CAE write failed." },
      { status: 404 },
    );
  }

  cloudLog({
    severity: "INFO",
    component: "Fiscal",
    action: "INVOICE_CAE_WRITEBACK_OK",
    a2a_transfer: false,
    message: `CAE fields written via internal endpoint — invoiceId=${invoiceId}`,
    data: { businessId, invoiceId, caeCode, fiscalNumero },
  });

  return NextResponse.json({ ok: true }, { status: 200 });
}
