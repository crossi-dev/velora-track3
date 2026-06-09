// Low-level MP API wrappers for Store and POS creation.
//
// Split from mp-pos-provisioning.ts (file-size contract: 300-line hard limit).
// This module contains only raw HTTP calls to the MP API with no DB concerns.
//
// ⚠️  SANDBOX VERIFICATION REQUIRED for all three functions below.
// See mp-pos-provisioning.ts for the full verification checklist.

import { cloudLog } from "@/lib/cloud-logger";
import { mpFetchWithBackoff } from "./mp-fetch";

const MP_API_BASE = "https://api.mercadopago.com";
const HTTP_TIMEOUT_MS = 8_000; // provisioning calls are non-critical-path

// Creates a Store under the seller's MP account.
// Returns the MP-assigned store_id on success, null on any failure.
// ⚠️ SANDBOX: verify that a minimal payload (name only) is accepted without
// mandatory location/business-hours fields — this varies by MP seller plan.
export async function createMpStore(params: {
  accessToken: string;
  mpUserId: string;
  businessName: string;
}): Promise<string | null> {
  const url = `${MP_API_BASE}/users/${encodeURIComponent(params.mpUserId)}/stores`;
  const body = {
    name: params.businessName.slice(0, 100),
    // business_hours and location are optional in MP's schema for basic stores.
    // If MP requires them for the seller's plan, provisioning will fail and we
    // surface the best-effort "retry in a moment" message.
  };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await mpFetchWithBackoff(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${params.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let parsed: unknown = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }

    if (!res.ok) {
      cloudLog({
        severity: "WARNING",
        component: "System",
        action: "MP_PROVISION_STORE_FAILED",
        a2a_transfer: false,
        message: `MP store creation failed status=${res.status}`,
        data: { status: res.status, body: typeof parsed === "object" ? parsed : text.slice(0, 300) },
      });
      return null;
    }
    const obj = parsed as Record<string, unknown>;
    const storeId = obj?.id != null ? String(obj.id) : null;
    if (!storeId) {
      cloudLog({
        severity: "WARNING",
        component: "System",
        action: "MP_PROVISION_STORE_BAD_SHAPE",
        a2a_transfer: false,
        message: "MP store creation response missing id",
        data: { body: text.slice(0, 300) },
      });
      return null;
    }
    return storeId;
  } catch (err) {
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "MP_PROVISION_STORE_ERROR",
      a2a_transfer: false,
      message: "MP store creation fetch threw",
      data: { error: err instanceof Error ? err.message : String(err) },
    });
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// Creates a POS under the seller's MP account, linked to the given store.
// Returns the POS external_id (we set it; MP echoes it back) on success, null on failure.
// ⚠️ SANDBOX: verify `fixed_amount: true` is accepted and `external_id` is echoed
// in the response body. Also verify the POS appears in GET /pos?external_id=... results.
export async function createMpPos(params: {
  accessToken: string;
  storeId: string;
  externalPosId: string;
  businessName: string;
}): Promise<string | null> {
  const url = `${MP_API_BASE}/pos`;
  const body = {
    name: `Velora POS – ${params.businessName}`.slice(0, 100),
    store_id: params.storeId,
    // external_id links our POS to the one used in QR PUT calls.
    // Must match buildVeloraPosExternalId(businessId).
    external_id: params.externalPosId,
    // fixed_amount: true means the QR requires a pre-loaded order amount
    // (our PUT-order flow). false would let the buyer type any amount.
    fixed_amount: true,
  };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await mpFetchWithBackoff(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${params.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let parsed: unknown = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }

    if (!res.ok) {
      cloudLog({
        severity: "WARNING",
        component: "System",
        action: "MP_PROVISION_POS_FAILED",
        a2a_transfer: false,
        message: `MP POS creation failed status=${res.status}`,
        data: { status: res.status, body: typeof parsed === "object" ? parsed : text.slice(0, 300) },
      });
      return null;
    }
    // MP echoes our external_id in the response. Prefer reading it from there;
    // if absent (unexpected), fall back to the value we sent.
    const obj = parsed as Record<string, unknown>;
    const echoedExternalId = typeof obj?.external_id === "string" ? obj.external_id : null;
    return echoedExternalId ?? params.externalPosId;
  } catch (err) {
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "MP_PROVISION_POS_ERROR",
      a2a_transfer: false,
      message: "MP POS creation fetch threw",
      data: { error: err instanceof Error ? err.message : String(err) },
    });
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// Checks if a POS with the given external_id already exists under the seller's account.
// Returns the external_id if found, null if not found or on error.
// Uses the same GET /pos?external_id= pattern as validatePosOnStartup in mp-qr.ts.
// ⚠️ SANDBOX: verify MP returns { results: [{ external_id: string, ... }] }.
export async function findExistingMpPos(params: {
  accessToken: string;
  externalPosId: string;
}): Promise<string | null> {
  const url = `${MP_API_BASE}/pos?external_id=${encodeURIComponent(params.externalPosId)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await mpFetchWithBackoff(url, {
      headers: { Authorization: `Bearer ${params.accessToken}` },
      signal: controller.signal,
    });
    if (!res.ok) return null; // treat as "not found" — will attempt creation
    const body = await res.json().catch(() => null) as { results?: Array<{ external_id?: string }> } | null;
    const match = body?.results?.find((p) => p.external_id === params.externalPosId);
    return match?.external_id ?? null;
  } catch {
    return null; // treat as "not found"
  } finally {
    clearTimeout(timeout);
  }
}
