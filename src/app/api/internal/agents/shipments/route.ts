// POST /api/internal/agents/shipments
//
// Internal endpoint: upserts an AndreaniShipment row on behalf of the Andreani
// agent worker — replacing its direct Prisma write with an HTTP call to core
// (Phase 2 S4 — agent-to-core HTTP, not direct DB).
//
// Auth: shared CRON_SECRET bearer token — same pattern as the biz-snapshot
// endpoint (src/app/api/internal/agents/biz-snapshot/route.ts).
// Timing-safe comparison prevents constant-time oracle attacks.
//
// Why not OIDC here: the caller is the Andreani agent (not Cloud Tasks). There
// is no SA-pinned OIDC token available in that context. CRON_SECRET bearer is
// the correct internal-service-to-service mechanism already established.
//
// Allowlist: /api/internal/agents/shipments is added to API_ALLOWLIST in
// middleware.ts (explicit per-endpoint entry, same pattern as biz-snapshot).
//
// Idempotency: the underlying upsertAndreaniShipment is idempotent by saleId
// (WHERE { saleId } unique constraint). Retries are safe.

import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { cloudLog } from "@/lib/cloud-logger";
import { prismaShipmentRepository } from "@/infrastructure/persistence/prisma-shipment.repository";

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

interface ShipmentUpsertBody {
  businessId: string;
  saleId: string;
  trackingNumber: string;
  service: string;
  labelPdfPath: string | null;
  /** ISO 8601 string — rehydrated to Date before DB write. */
  estimatedDelivery: string;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!verifyBearer(req.headers.get("authorization"))) {
    cloudLog({
      severity: "WARNING",
      component: "A2A",
      action: "SHIPMENT_WRITEBACK_AUTH_FAILED",
      a2a_transfer: false,
      message: "shipments: unauthorized request — bearer mismatch or missing",
    });
    return NextResponse.json(
      { code: "UNAUTHORIZED", message: "Authentication required." },
      { status: 401 },
    );
  }

  let body: ShipmentUpsertBody;
  try {
    body = (await req.json()) as ShipmentUpsertBody;
  } catch {
    return NextResponse.json(
      { code: "BAD_REQUEST", message: "Invalid JSON body." },
      { status: 400 },
    );
  }

  const { businessId, saleId, trackingNumber, service, labelPdfPath, estimatedDelivery } = body;

  if (!businessId || !saleId || !trackingNumber || !service || !estimatedDelivery) {
    return NextResponse.json(
      { code: "BAD_REQUEST", message: "Missing required field(s): businessId, saleId, trackingNumber, service, estimatedDelivery." },
      { status: 400 },
    );
  }

  const estimatedDeliveryDate = new Date(estimatedDelivery);
  if (isNaN(estimatedDeliveryDate.getTime())) {
    return NextResponse.json(
      { code: "BAD_REQUEST", message: "estimatedDelivery must be a valid ISO 8601 date string." },
      { status: 400 },
    );
  }

  try {
    await prismaShipmentRepository.upsertAndreaniShipment({
      businessId,
      saleId,
      trackingNumber,
      service,
      labelPdfPath: labelPdfPath ?? null,
      estimatedDelivery: estimatedDeliveryDate,
    });

    cloudLog({
      severity: "INFO",
      component: "A2A",
      action: "SHIPMENT_WRITEBACK_OK",
      a2a_transfer: false,
      message: `Shipment upserted via internal endpoint — tracking=${trackingNumber}`,
      data: { businessId, saleId, trackingNumber },
    });

    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (err) {
    cloudLog({
      severity: "ERROR",
      component: "A2A",
      action: "SHIPMENT_WRITEBACK_DB_ERROR",
      a2a_transfer: false,
      message: "shipments: DB upsert threw",
      data: {
        businessId,
        saleId,
        trackingNumber,
        errorName: err instanceof Error ? err.name : "NonError",
        errorMessage: err instanceof Error ? err.message : String(err),
      },
    });
    return NextResponse.json(
      { code: "INTERNAL_ERROR", message: "Failed to persist shipment." },
      { status: 500 },
    );
  }
}
