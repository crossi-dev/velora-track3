// Andreani shipment writeback — HTTP call to the core internal endpoint.
//
// Phase 2 S4: replaces the direct prismaShipmentRepository.upsertAndreaniShipment
// call in shipment-create.ts with a POST /api/internal/agents/shipments call to
// core. Auth: CRON_SECRET bearer (same pattern as payments-biz-prefetch.ts).
//
// Error contract (hard stop): on any failure (network, timeout, non-200) throws
// ShipmentWritebackError. The caller MUST NOT proceed as if the shipment was
// written — a shipment-create that fails to persist must surface failure, not
// pretend success. Mirrors the BizPrefetchHttpError hard-stop pattern.
//
// Direction: VELORA_APP_URL (not AGENTS_BASE_URL) — this is agent → core.

import { getCoreBaseUrl } from "@/lib/core-base-url";
import { cloudLog } from "@/lib/cloud-logger";

/** Thrown when the shipment writeback HTTP call fails. */
export class ShipmentWritebackError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "ShipmentWritebackError";
  }
}

export interface ShipmentWritebackArgs {
  businessId: string;
  saleId: string;
  trackingNumber: string;
  service: string;
  labelPdfPath: string | null;
  estimatedDelivery: Date;
}

// 10s default (env-overridable). The outer Andreani agent timeout is the real
// backstop, but this is a WRITE over cold Supabase pgbouncer (2-4s under load) —
// too tight a timeout would abort an upsert that was going to succeed, leaving
// the shipment in Andreani but NOT persisted in Velora (JD S4 finding).
const SHIPMENT_WRITEBACK_TIMEOUT_MS =
  Number(process.env.SHIPMENT_WRITEBACK_TIMEOUT_MS) || 10_000;

export async function writebackShipment(args: ShipmentWritebackArgs): Promise<void> {
  const secret = process.env.CRON_SECRET ?? "";
  if (!secret) {
    cloudLog({
      severity: "ERROR",
      component: "A2A",
      action: "SHIPMENT_WRITEBACK_NO_SECRET",
      a2a_transfer: false,
      message: "writebackShipment: CRON_SECRET is not set — cannot authenticate to core",
      data: { businessId: args.businessId, saleId: args.saleId },
    });
    throw new ShipmentWritebackError("CRON_SECRET not configured");
  }

  const url = `${getCoreBaseUrl()}/api/internal/agents/shipments`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SHIPMENT_WRITEBACK_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify({
        businessId: args.businessId,
        saleId: args.saleId,
        trackingNumber: args.trackingNumber,
        service: args.service,
        labelPdfPath: args.labelPdfPath,
        estimatedDelivery: args.estimatedDelivery.toISOString(),
      }),
      signal: controller.signal,
    });
  } catch (err) {
    cloudLog({
      severity: "ERROR",
      component: "A2A",
      action: "SHIPMENT_WRITEBACK_FETCH_ERROR",
      a2a_transfer: false,
      message: "writebackShipment: HTTP call to core failed",
      data: {
        businessId: args.businessId,
        saleId: args.saleId,
        errorName: err instanceof Error ? err.name : "NonError",
        errorMessage: err instanceof Error ? err.message : String(err),
      },
    });
    throw new ShipmentWritebackError(err instanceof Error ? err.message : "fetch_failed");
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    cloudLog({
      severity: "ERROR",
      component: "A2A",
      action: "SHIPMENT_WRITEBACK_HTTP_ERROR",
      a2a_transfer: false,
      message: `writebackShipment: core returned ${res.status}`,
      data: { businessId: args.businessId, saleId: args.saleId, status: res.status },
    });
    throw new ShipmentWritebackError(`non-200 from core: ${res.status}`, res.status);
  }
}
