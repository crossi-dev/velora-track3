// Payments biz-snapshot prefetch — HTTP call to the core internal endpoint.
//
// Phase 2 S3: replaces the direct prisma.business + prisma.mpConnection read
// with a GET /api/internal/agents/biz-snapshot?businessId=... call to the
// core. Auth: CRON_SECRET bearer (same secret the whatsapp-inbound task uses).
//
// Error contract (money path): on any failure (network, timeout, non-200)
// throws BizPrefetchHttpError. Callers MUST propagate this as a structured
// RPC error — a payment flow must NOT continue with missing business data.
//
// Direction: VELORA_APP_URL (not AGENTS_BASE_URL) — this is agent → core.

import { getCoreBaseUrl } from "@/lib/core-base-url";
import { cloudLog } from "@/lib/cloud-logger";
import type { BizSnapshot } from "./payments-agent-types";

export interface BizPrefetchResult {
  actorUserId: string | null;
  bizSnapshot: BizSnapshot | null;
}

/** Thrown when the HTTP prefetch fails — callers return a structured RPC error. */
export class BizPrefetchHttpError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "BizPrefetchHttpError";
  }
}

// Short timeout on the critical path. The outer PAYMENTS_ADK_TIMEOUT_MS (60s)
// is the real backstop; 5s covers a cold DB round-trip + serialization.
const BIZ_SNAPSHOT_TIMEOUT_MS = 5_000;

/** Shape returned by GET /api/internal/agents/biz-snapshot */
interface BizSnapshotApiResponse {
  business: {
    userId: string | null;
    name: string | null;
    paymentProvider: string | null;
    postalCode: string | null;
    alias: string | null;
    whatsappPhone: string | null;
    cuit: string | null;
    courierPreference: string | null;
  };
  mpConnection: {
    accessTokenCiphertext: string | null;
    expiresAt: string; // ISO string — JSON-serialized Date
    scope: string | null;
  } | null;
}

export async function prefetchBizSnapshot(businessId: string): Promise<BizPrefetchResult> {
  const secret = process.env.CRON_SECRET ?? "";
  if (!secret) {
    cloudLog({
      severity: "ERROR",
      component: "A2A",
      action: "BIZ_SNAPSHOT_NO_SECRET",
      a2a_transfer: false,
      message: "prefetchBizSnapshot: CRON_SECRET is not set — cannot authenticate to core",
      data: { businessId },
    });
    throw new BizPrefetchHttpError("CRON_SECRET not configured");
  }

  const url = `${getCoreBaseUrl()}/api/internal/agents/biz-snapshot?businessId=${encodeURIComponent(businessId)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BIZ_SNAPSHOT_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${secret}` },
      signal: controller.signal,
    });
  } catch (err) {
    cloudLog({
      severity: "ERROR",
      component: "A2A",
      action: "BIZ_SNAPSHOT_FETCH_ERROR",
      a2a_transfer: false,
      message: "prefetchBizSnapshot: HTTP call to core failed",
      data: {
        businessId,
        errorName: err instanceof Error ? err.name : "NonError",
        errorMessage: err instanceof Error ? err.message : String(err),
      },
    });
    throw new BizPrefetchHttpError(err instanceof Error ? err.message : "fetch_failed");
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 404) {
    // Business does not exist — not a transient error, return null snapshot.
    return { actorUserId: null, bizSnapshot: null };
  }

  if (!res.ok) {
    cloudLog({
      severity: "ERROR",
      component: "A2A",
      action: "BIZ_SNAPSHOT_HTTP_ERROR",
      a2a_transfer: false,
      message: `prefetchBizSnapshot: core returned ${res.status}`,
      data: { businessId, status: res.status },
    });
    throw new BizPrefetchHttpError("non-200 from core", res.status);
  }

  let data: BizSnapshotApiResponse;
  try {
    data = (await res.json()) as BizSnapshotApiResponse;
  } catch (parseErr) {
    cloudLog({
      severity: "ERROR",
      component: "A2A",
      action: "BIZ_SNAPSHOT_PARSE_ERROR",
      a2a_transfer: false,
      message: "prefetchBizSnapshot: failed to parse core response",
      data: { businessId, errorMessage: parseErr instanceof Error ? parseErr.message : String(parseErr) },
    });
    throw new BizPrefetchHttpError("json_parse_failed");
  }

  const { business: biz, mpConnection: mpConn } = data;

  const actorUserId = biz.userId ?? null;
  const bizSnapshot: BizSnapshot = {
    paymentProvider: biz.paymentProvider,
    postalCode: biz.postalCode,
    alias: biz.alias,
    whatsappPhone: biz.whatsappPhone,
    cuit: biz.cuit,
    name: biz.name,
    courierPreference: biz.courierPreference ?? null,
    hasMpConnection: Boolean(mpConn),
    mpConnectionRaw: mpConn
      ? {
          accessTokenCiphertext: mpConn.accessTokenCiphertext,
          // Rehydrate ISO string to Date — JSON serialization loses Date type.
          expiresAt: new Date(mpConn.expiresAt),
          scope: mpConn.scope,
        }
      : null,
  };

  return { actorUserId, bizSnapshot };
}
