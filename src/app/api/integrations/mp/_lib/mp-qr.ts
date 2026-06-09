// MP QR dinámico — wrapper sobre el endpoint legacy in-store de Mercado Pago.
//
// PUT /instore/orders/qr/seller/collectors/{user_id}/pos/{external_pos_id}/qrs
//   - Crea/actualiza el QR activo del POS con un order pendiente.
//   - El endpoint es "single active order per POS" — una segunda llamada
//     reemplaza el order anterior. V1 asume 1 caja por business, en línea
//     con el PRD madre.
//
// Devuelve `qr_data` (string que el cliente escanea). Si MP devuelve error
// o el shape no matchea, retornamos null y el caller cae al fake.
//
// Documentación: developers.mercadopago.com.ar (in-store payments → QR
// dinámico). Sandbox y producción comparten endpoint; el access_token define
// el ambiente.

import { createHash } from "crypto";
import { cloudLog } from "@/lib/cloud-logger";
import { mpFetchWithBackoff } from "./mp-fetch";

const MP_API_BASE = "https://api.mercadopago.com";
const HTTP_TIMEOUT_MS = 4_000;

// ── App URL resolver ──────────────────────────────────────────────────────────
// notification_url is required on every QR PUT so MP fires the webhook
// deterministically (no dependency on MP dashboard setting). Prefer
// VELORA_APP_URL when set; fall back to NEXTAUTH_URL (always populated in
// prod). Logs ERROR only when both are absent — empty return signals caller
// to throw rather than send a body without notification_url.
function getAppUrl(): string {
  const explicit = (process.env.VELORA_APP_URL ?? "").trim();
  if (explicit) return explicit;
  const nextauth = (process.env.NEXTAUTH_URL ?? "").trim();
  if (nextauth) return nextauth;
  cloudLog({
    severity: "ERROR",
    component: "System",
    action: "MP_QR_MISSING_APP_URL",
    a2a_transfer: false,
    message: "Neither VELORA_APP_URL nor NEXTAUTH_URL is set — notification_url cannot be built. QR creation will be aborted.",
  });
  return "";
}

// ── POS existence check (lazy, TTL-cached) ────────────────────────────────────
// Validates that the POS exists in MP before trying to PUT an order.
// Returns true if POS exists or cannot be verified (non-blocking), false if confirmed absent.
// Cache expires after 1h so stale "POS exists" signals don't persist across
// POS deletion/recreation, and transient MP outages can self-heal on the next cycle.
// Keyed by externalPosId — each POS/tenant gets its own TTL slot.
// A module-level scalar would be shared across all businesses on the same
// Cloud Run instance, causing false "already validated" hits for other tenants.
const posValidatedAt = new Map<string, number>();
const POS_VALIDATION_TTL_MS = 60 * 60 * 1000; // 1h

export async function validatePosOnStartup(
  input: { accessToken: string; mpUserId: string; externalPosId: string },
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; missingPos: boolean }> {
  const lastValidated = posValidatedAt.get(input.externalPosId);
  if (lastValidated !== undefined && Date.now() - lastValidated < POS_VALIDATION_TTL_MS) {
    return { ok: true, missingPos: false };
  }

  // MP's `/pos/{id}` route expects MP's INTERNAL numeric id, not external_id.
  // To check existence by external_id we have to list and filter — there is
  // no `GET /pos/by-external/{external_id}` endpoint.
  const url = `${MP_API_BASE}/pos?external_id=${encodeURIComponent(input.externalPosId)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${input.accessToken}` },
      signal: controller.signal,
    });
    if (res.ok) {
      const body = await res.json().catch(() => null) as { results?: Array<{ external_id?: string }> } | null;
      const found = !!body?.results?.some((p) => p.external_id === input.externalPosId);
      if (!found) {
        cloudLog({
          severity: "ERROR",
          component: "System",
          action: "MP_POS_NOT_FOUND",
          a2a_transfer: false,
          message: `POS ${input.externalPosId} not found in MP — QR will fall back to static placeholder`,
          data: { externalPosId: input.externalPosId, mpUserId: input.mpUserId },
        });
        return { ok: false, missingPos: true };
      }
      posValidatedAt.set(input.externalPosId, Date.now());
      return { ok: true, missingPos: false };
    }
    // Any other non-2xx: log warn, treat as non-blocking
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "MP_POS_VALIDATE_WARN",
      a2a_transfer: false,
      message: `POS validation returned status=${res.status}, proceeding anyway`,
      data: { status: res.status },
    });
    return { ok: true, missingPos: false };
  } catch (err) {
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "MP_POS_VALIDATE_ERROR",
      a2a_transfer: false,
      message: "POS validation fetch threw, proceeding anyway",
      data: { error: err instanceof Error ? err.message : String(err) },
    });
    return { ok: true, missingPos: false };
  } finally {
    clearTimeout(timeout);
  }
}

export interface CreateMpQrInput {
  accessToken: string;
  mpUserId: string;
  externalPosId: string;
  externalReference: string; // "{businessId}:{paymentIntentId}" — webhook lo parsea
  businessId: string; // used to build notification_url with ?businessId= for multi-seller path
  monto: number;
  description: string;
  expiresAt: Date;
}

export interface CreateMpQrResult {
  qrData: string;
  inStoreOrderId: string | null;
}

export async function createMpDynamicQr(
  input: CreateMpQrInput,
  _fetchImpl: typeof fetch = fetch,
): Promise<CreateMpQrResult | null> {
  const appUrl = getAppUrl();
  if (!appUrl) {
    cloudLog({
      severity: "ERROR",
      component: "System",
      action: "MP_QR_ABORT_NO_NOTIFICATION_URL",
      a2a_transfer: false,
      message: "Refusing to create QR without notification_url — webhook would never fire.",
    });
    return null;
  }
  const notificationUrl = `${appUrl}/api/integrations/mp/webhook?businessId=${encodeURIComponent(input.businessId)}`;

  const url = `${MP_API_BASE}/instore/orders/qr/seller/collectors/${encodeURIComponent(input.mpUserId)}/pos/${encodeURIComponent(input.externalPosId)}/qrs`;
  const body: Record<string, unknown> = {
    external_reference: input.externalReference,
    notification_url: notificationUrl,
    title: "Cobro Velora",
    description: input.description,
    total_amount: input.monto,
    items: [
      {
        title: "Venta",
        unit_price: input.monto,
        quantity: 1,
        unit_measure: "unit",
        total_amount: input.monto,
      },
    ],
    expiration_date: input.expiresAt.toISOString(),
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const response = await mpFetchWithBackoff(url, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        "Content-Type": "application/json",
        // Stable hash of the external reference — unique per PaymentIntent,
        // survives retries without re-creating a new order on the POS.
        "X-Idempotency-Key": createHash("sha256").update(input.externalReference).digest("hex").slice(0, 32),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let parsed: unknown = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }

    if (!response.ok) {
      cloudLog({
        severity: "ERROR",
        component: "System",
        action: "MP_QR_CREATE_FAILED",
        a2a_transfer: false,
        message: `MP QR create failed status=${response.status}`,
        data: { status: response.status, body: parsed ?? text.slice(0, 500) },
      });
      return null;
    }

    if (!parsed || typeof parsed !== "object") {
      cloudLog({
        severity: "ERROR",
        component: "System",
        action: "MP_QR_BAD_SHAPE",
        a2a_transfer: false,
        message: "MP QR response not an object",
        data: { body: text.slice(0, 500) },
      });
      return null;
    }
    const obj = parsed as Record<string, unknown>;
    const qrData = typeof obj.qr_data === "string" ? obj.qr_data : null;
    if (!qrData) {
      cloudLog({
        severity: "ERROR",
        component: "System",
        action: "MP_QR_NO_QR_DATA",
        a2a_transfer: false,
        message: "MP QR response missing qr_data",
        data: { body: obj },
      });
      return null;
    }
    const inStoreOrderId =
      typeof obj.in_store_order_id === "string" ? obj.in_store_order_id : null;
    return { qrData, inStoreOrderId };
  } catch (error) {
    cloudLog({
      severity: "ERROR",
      component: "System",
      action: "MP_QR_NETWORK_ERROR",
      a2a_transfer: false,
      message: "MP QR fetch threw",
      data: { error: error instanceof Error ? error.message : String(error) },
    });
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// DELETE invalidates the active QR del POS. Idempotente — si no hay order
// activo, MP devuelve 404 y lo tratamos como success silencioso.
export async function deleteMpDynamicQr(
  input: { accessToken: string; mpUserId: string; externalPosId: string },
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const url = `${MP_API_BASE}/instore/orders/qr/seller/collectors/${encodeURIComponent(input.mpUserId)}/pos/${encodeURIComponent(input.externalPosId)}/qrs`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${input.accessToken}` },
      signal: controller.signal,
    });
    return response.ok || response.status === 404;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}
