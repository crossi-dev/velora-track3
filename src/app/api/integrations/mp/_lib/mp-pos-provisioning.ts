// Auto-provisioning orchestrator — MP Store + POS under the seller's account.
//
// WS1-B: when a business connects their MP account via OAuth, Velora must
// create a Store and a Point-of-Sale (POS) under their collector user_id so
// that QR in-store cobro (PUT /instore/orders/qr/…) can work immediately.
//
// Split: raw MP API calls live in mp-pos-api.ts (file-size contract).
// This file handles DB reads, idempotency orchestration, and persistence.
//
// Design decisions:
//   - DETERMINISTIC external_id: "VELORA-{businessId}" — stable across re-runs,
//     avoids duplicates, namespaced to avoid colliding with any POS the owner
//     already has in their MP account.
//   - IDEMPOTENT: before creating, lists existing POS for this external_id;
//     reuses if found. Safe to call multiple times (e.g. callback + lazy).
//   - BEST-EFFORT: if any MP API call fails we log clearly and return
//     { ok: false }. The OAuth connect flow and QR flow surface a friendly
//     message; they do NOT fail because of a provisioning error.
//
// ⚠️  SANDBOX VERIFICATION REQUIRED — see mp-pos-api.ts for per-call checklist:
//   - POST /users/{mpUserId}/stores — minimal payload accepted?
//   - POST /pos — fixed_amount:true + external_id echo?
//   - GET /pos?external_id=... — results[] shape?

import { cloudLog } from "@/lib/cloud-logger";
import { prisma } from "@/lib/prisma";
import { createMpStore, createMpPos, findExistingMpPos } from "./mp-pos-api";

// Result returned from ensureMpStorePosProvisioned.
export type ProvisionResult =
  | { ok: true; externalPosId: string; created: boolean }
  | { ok: false; reason: string };

// Builds the deterministic, namespaced external_id for a business's POS.
// Format: "VELORA-{businessId}" — stable, unique per business, cannot collide
// with POS the owner already has (those would need to use this exact prefix).
export function buildVeloraPosExternalId(businessId: string): string {
  return `VELORA-${businessId}`;
}

// Persists externalPosId to MpConnection (best-effort — logs but does not throw).
async function persistExternalPosId(businessId: string, externalPosId: string): Promise<void> {
  try {
    await prisma.mpConnection.update({
      where: { businessId },
      data: { externalPosId },
    });
  } catch (dbErr) {
    cloudLog({
      severity: "ERROR",
      component: "System",
      action: "MP_PROVISION_PERSIST_FAILED",
      a2a_transfer: false,
      message: "ensureMpStorePosProvisioned: failed to persist externalPosId to DB",
      data: { businessId, externalPosId, error: dbErr instanceof Error ? dbErr.message : String(dbErr) },
    });
  }
}

// Main entry point: idempotently provisions a Store + POS under the seller's
// MP account, then persists the externalPosId to MpConnection.
//
// Idempotency:
//   1. Reads MpConnection.externalPosId — if already set, returns immediately.
//   2. Lists MP POS with GET /pos?external_id=VELORA-{businessId} — reuses if found.
//   3. Otherwise creates store → POS.
//   4. Persists externalPosId into MpConnection on success.
//
// Best-effort: returns { ok: false } on any MP API failure. Caller must NOT
// fail the OAuth connect flow — it logs the error and continues.
export async function ensureMpStorePosProvisioned(params: {
  businessId: string;
  accessToken: string;
  mpUserId: string;
}): Promise<ProvisionResult> {
  const { businessId, accessToken, mpUserId } = params;
  const externalPosId = buildVeloraPosExternalId(businessId);

  // Step 0: check DB — already provisioned?
  try {
    const existing = await prisma.mpConnection.findUnique({
      where: { businessId },
      select: { externalPosId: true },
    });
    if (existing?.externalPosId) {
      return { ok: true, externalPosId: existing.externalPosId, created: false };
    }
  } catch (dbErr) {
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "MP_PROVISION_DB_READ_FAILED",
      a2a_transfer: false,
      message: "ensureMpStorePosProvisioned: DB read threw — proceeding anyway",
      data: { businessId, error: dbErr instanceof Error ? dbErr.message : String(dbErr) },
    });
    // proceed — we'll try MP and persist if successful
  }

  // Step 1: check MP — POS already exists with this external_id?
  const foundExternalId = await findExistingMpPos({ accessToken, externalPosId });
  if (foundExternalId) {
    cloudLog({
      severity: "INFO",
      component: "System",
      action: "MP_PROVISION_POS_REUSED",
      a2a_transfer: false,
      message: "MP POS already exists — reusing",
      data: { businessId, externalPosId: foundExternalId },
    });
    await persistExternalPosId(businessId, foundExternalId);
    return { ok: true, externalPosId: foundExternalId, created: false };
  }

  // Step 2: need to provision. Fetch business name for labeling.
  let businessName = "Velora";
  try {
    const biz = await prisma.business.findUnique({
      where: { id: businessId },
      select: { name: true },
    });
    if (biz?.name) businessName = biz.name;
  } catch { /* non-fatal — use default name */ }

  // Step 3: create Store.
  const storeId = await createMpStore({ accessToken, mpUserId, businessName });
  if (!storeId) {
    return {
      ok: false,
      reason: "MP store creation failed — see MP_PROVISION_STORE_FAILED log",
    };
  }

  // Step 4: create POS linked to the new Store.
  const createdPosId = await createMpPos({
    accessToken,
    storeId,
    externalPosId,
    businessName,
  });
  if (!createdPosId) {
    return {
      ok: false,
      reason: "MP POS creation failed — see MP_PROVISION_POS_FAILED log",
    };
  }

  // Step 5: persist externalPosId to MpConnection.
  await persistExternalPosId(businessId, createdPosId);

  cloudLog({
    severity: "INFO",
    component: "System",
    action: "MP_PROVISION_COMPLETE",
    a2a_transfer: false,
    message: "MP store + POS provisioned successfully",
    data: { businessId, storeId, externalPosId: createdPosId },
  });

  return { ok: true, externalPosId: createdPosId, created: true };
}
