// ModoAdapter — implements PaymentProviderAdapter for MODO (Argentine digital wallet).
//
// API source: open-source WooCommerce plugin "Paga con MODO" (ingenieriamodo, v1.1.0).
// Base URL: https://merchants.playdigital.com.ar/merchants
// Auth:     POST /middleman/token  { username: clientId, password: clientSecret } → JWT
// Create:   POST /ecommerce/payment-intention
// Status:   GET  /ecommerce/payment-intention/{intentionId}
// Webhook:  POST /api/integrations/modo/webhook (registered via PATCH /middleman/)
//
// Credentials stored encrypted (AES-256-GCM) in ModoConnection.encryptedCredentials.
// Fields: clientId, clientSecret, storeId.

import { prisma } from "@/lib/prisma";
import { decrypt } from "@velora/core-utils/mp-token-cipher";
import { cloudLog } from "@/lib/cloud-logger";
import {
  loadModoCredentials,
  getModoToken,
  createModoIntention,
  getModoIntentionStatus,
  MODO_TOKEN_NOT_CONNECTED,
  MODO_TOKEN_DECRYPT_ERROR,
  MODO_TOKEN_NETWORK_ERROR,
} from "@/app/api/integrations/modo/_lib/modo-api-helpers";
import type {
  PaymentProviderAdapter,
  CollectionResult,
  PaymentStatusResult,
} from "../payment-provider";

export class ModoAdapter implements PaymentProviderAdapter {

  async createCollection(params: {
    paymentIntentId: string;
    amountARS: number;
    description: string;
    customerName?: string;
    businessId: string;
  }): Promise<CollectionResult | { error: string; detail?: unknown }> {
    const { paymentIntentId, amountARS, description, businessId } = params;

    // ── Load and decrypt credentials ────────────────────────────────────────
    const creds = await loadModoCredentials(businessId);
    if (creds === MODO_TOKEN_NOT_CONNECTED) {
      return {
        error: "payment_provider_not_connected",
        detail: "Conectá tu cuenta MODO en Ajustes antes de cobrar.",
      };
    }
    if (creds === MODO_TOKEN_DECRYPT_ERROR) {
      return {
        error: "payment_token_decrypt_error",
        detail: "No se pudo leer las credenciales MODO. Reconectá tu cuenta en Ajustes.",
      };
    }

    // ── Obtain Bearer token ──────────────────────────────────────────────────
    const token = await getModoToken(businessId, creds);
    if (!token || token === MODO_TOKEN_NETWORK_ERROR) {
      return {
        error: "payment_provider_auth_failed",
        detail: "No se pudo autenticar con MODO. Verificá tus credenciales en Ajustes.",
      };
    }

    // ── Create payment intention ─────────────────────────────────────────────
    // External reference = "{businessId}:{paymentIntentId}" — webhook parser splits on ":"
    const externalIntentionId = `${businessId}:${paymentIntentId}`;

    const result = await createModoIntention({
      businessId,
      storeId: creds.storeId,
      accessToken: token,
      amountARS,
      description,
      externalIntentionId,
    });

    if ("error" in result) {
      return { error: result.error, detail: result.detail };
    }

    // ── Persist intentionId as providerRef for getStatus() ──────────────────
    const { count } = await prisma.paymentIntent.updateMany({
      where: { id: paymentIntentId, businessId },
      data: { providerRef: result.intentionId },
    });
    if (count === 0) {
      cloudLog({
        severity: "WARNING",
        component: "A2A",
        action: "MODO_PROVIDER_REF_UPDATE_MISS",
        a2a_transfer: false,
        message: "updateMany(providerRef) afectó 0 filas — id/businessId mismatch o fila faltante",
        data: { paymentIntentId, businessId },
      });
    }

    return {
      paymentIntentId,
      amountARS,
      checkoutUrl: result.checkoutUrl ?? undefined,
      providerRef: result.intentionId,
      status: "pending",
      currency: "ARS",
    };
  }

  async getStatus(params: {
    paymentIntentId: string;
    businessId: string;
  }): Promise<PaymentStatusResult> {
    const { paymentIntentId, businessId } = params;

    // ── Load credentials ─────────────────────────────────────────────────────
    const creds = await loadModoCredentials(businessId);
    if (creds === MODO_TOKEN_NOT_CONNECTED) {
      return {
        paymentIntentId,
        status: "error",
        detail: "payment_provider_not_connected",
        message: "Conectá tu cuenta MODO en Ajustes antes de consultar pagos.",
        currency: "ARS",
      };
    }
    if (creds === MODO_TOKEN_DECRYPT_ERROR) {
      return {
        paymentIntentId,
        status: "error",
        detail: "payment_token_decrypt_error",
        message: "No se pudo leer las credenciales MODO. Reconectá tu cuenta en Ajustes.",
        currency: "ARS",
      };
    }

    // ── Obtain Bearer token ──────────────────────────────────────────────────
    const token = await getModoToken(businessId, creds);
    if (!token || token === MODO_TOKEN_NETWORK_ERROR) {
      return {
        paymentIntentId,
        status: "error",
        detail: "payment_provider_auth_failed",
        message: "No se pudo autenticar con MODO.",
        currency: "ARS",
      };
    }

    // ── Resolve MODO intentionId from DB ─────────────────────────────────────
    const intent = await prisma.paymentIntent.findFirst({
      where: { id: paymentIntentId, businessId },
      select: { providerRef: true },
    });
    if (!intent) {
      return { paymentIntentId, status: "error", detail: "intent_not_found", currency: "ARS" };
    }
    const intentionId = intent.providerRef ?? null;
    if (!intentionId) {
      return { paymentIntentId, status: "error", detail: "intent_sin_provider_ref", currency: "ARS" };
    }

    // ── Query MODO API ───────────────────────────────────────────────────────
    const result = await getModoIntentionStatus({ businessId, intentionId, accessToken: token });
    if ("error" in result) {
      return {
        paymentIntentId,
        status: "error",
        detail: result.detail,
        currency: "ARS",
      };
    }

    // Map MODO status → Velora canonical status
    const status = mapModoStatusToVelora(result.status);
    return {
      paymentIntentId,
      status,
      providerRef: intentionId,
      detail: result.raw,
      currency: "ARS",
    };
  }

  // ── Internal helper ───────────────────────────────────────────────────────

  /** Returns true if a valid ModoConnection row exists and decrypts correctly. */
  async isConnected(businessId: string): Promise<boolean> {
    try {
      const row = await prisma.modoConnection.findUnique({
        where: { businessId },
        select: { encryptedCredentials: true },
      });
      if (!row) return false;
      decrypt(row.encryptedCredentials);
      return true;
    } catch {
      return false;
    }
  }
}

// ── Status mapping ────────────────────────────────────────────────────────────

function mapModoStatusToVelora(
  modoStatus: string,
): "pending" | "approved" | "rejected" | "error" {
  switch (modoStatus.toUpperCase()) {
    case "ACCEPTED": return "approved";
    case "REJECTED":
    case "CANCELLED": return "rejected";
    case "CREATED": return "pending";
    default: return "pending";
  }
}
