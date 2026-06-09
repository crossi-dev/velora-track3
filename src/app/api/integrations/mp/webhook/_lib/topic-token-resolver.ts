// Token resolution for MP webhook topics.
//
// "payment" (Checkout Pro) requires the per-business token — the payment was
// created under the selling business's MP account, so using the central token
// returns 404/403.
//
// "merchant_order" (QR in-store) also requires the per-business token when the
// business has an MpConnection — the QR was PUT under their collector user_id,
// so MP will 403 if we GET the merchant_order with the central token. Falls back
// to the central env token only when the business has no MpConnection row
// (MP_TOKEN_NOT_CONNECTED), for single-seller / demo compatibility.
//
// Returns the resolved access token string, or a NextResponse early-exit
// (typed as TokenResolverResult) the caller must return immediately.

import { NextResponse } from "next/server";
import { cloudLog } from "@/lib/cloud-logger";
import { prisma } from "@/lib/prisma";
import { getMpAccessToken } from "../../_lib/mp-routing";
import {
  getMpTokenForBusiness,
  MP_TOKEN_NOT_CONNECTED,
  MP_TOKEN_EXPIRED,
  MP_TOKEN_DECRYPT_ERROR,
} from "@/app/api/agents/payments/jsonrpc/_lib/mp-api-helpers";

export type TokenResolverResult =
  | { kind: "token"; accessToken: string }
  | { kind: "early"; response: NextResponse };

export async function resolveWebhookToken(
  topic: string,
  businessIdFromQuery: string | null,
  mpOrderId: string,
): Promise<TokenResolverResult> {
  if (topic === "payment") {
    // Per-business token path for Checkout Pro link payments.
    // businessIdFromQuery is absent for preferences created before the
    // notification_url ?businessId= fix. Fall back to a DB lookup by
    // providerRef (the MP preference_id) so those intents don't stay pending.
    let resolvedBusinessId = businessIdFromQuery;
    if (!resolvedBusinessId) {
      // Use findMany(take:2) instead of findFirst to detect duplicate providerRef rows
      // (data integrity gap — providerRef has no unique index today). If two rows
      // match we log CRITICAL and use the first; findFirst would silently pick one.
      // Ref: B7 fix #10 — non-unique providerRef detection without schema change.
      const intents = await prisma.paymentIntent.findMany({
        where: { providerRef: mpOrderId },
        select: { businessId: true },
        take: 2,
      });
      if (intents.length > 1) {
        cloudLog({
          severity: "CRITICAL",
          component: "System",
          action: "MP_WEBHOOK_DUPLICATE_PROVIDER_REF",
          a2a_transfer: false,
          message: `payment topic: multiple PaymentIntent rows share providerRef=${mpOrderId} — data integrity gap; using first match`,
          data: { mpOrderId, count: intents.length },
        });
      }
      const intent = intents[0] ?? null;
      if (intent) {
        resolvedBusinessId = intent.businessId;
        cloudLog({
          severity: "INFO",
          component: "System",
          action: "MP_WEBHOOK_BUSINESS_ID_FROM_DB",
          a2a_transfer: false,
          message: "payment topic sin ?businessId= — businessId recuperado via DB lookup por providerRef",
          data: { mpOrderId, resolvedBusinessId },
        });
      } else {
        cloudLog({
          severity: "WARNING",
          component: "System",
          action: "MP_WEBHOOK_NO_BUSINESS_ID",
          a2a_transfer: false,
          message: "payment topic sin ?businessId= y sin match en DB — notificación ignorada",
          data: { mpOrderId },
        });
        return {
          kind: "early",
          response: NextResponse.json({ ok: true, ignored: "no_business_id_for_payment" }),
        };
      }
    }

    const tokenResult = await getMpTokenForBusiness(resolvedBusinessId);

    if (tokenResult === MP_TOKEN_NOT_CONNECTED) {
      cloudLog({
        severity: "ERROR",
        component: "System",
        action: "MP_WEBHOOK_TOKEN_NOT_CONNECTED",
        a2a_transfer: false,
        message: "payment topic: businessId no tiene cuenta MP conectada — no se puede verificar",
        data: { resolvedBusinessId, mpOrderId },
      });
      return {
        kind: "early",
        response: NextResponse.json({ ok: true, ignored: "business_mp_not_connected" }),
      };
    }
    if (tokenResult === MP_TOKEN_EXPIRED) {
      cloudLog({
        severity: "ERROR",
        component: "System",
        action: "MP_WEBHOOK_TOKEN_EXPIRED",
        a2a_transfer: false,
        message: "payment topic: token del negocio expirado — no se puede verificar el pago",
        data: { resolvedBusinessId, mpOrderId },
      });
      return {
        kind: "early",
        response: NextResponse.json({ ok: true, ignored: "business_mp_token_expired" }),
      };
    }
    if (tokenResult === MP_TOKEN_DECRYPT_ERROR) {
      cloudLog({
        severity: "ERROR",
        component: "System",
        action: "MP_WEBHOOK_TOKEN_DECRYPT_ERROR",
        a2a_transfer: false,
        message:
          "payment topic: error descifrando token del negocio — no se puede verificar el pago",
        data: { resolvedBusinessId, mpOrderId },
      });
      return {
        kind: "early",
        response: NextResponse.json({ ok: true, ignored: "business_mp_token_decrypt_error" }),
      };
    }
    if (!tokenResult) {
      cloudLog({
        severity: "ERROR",
        component: "System",
        action: "MP_WEBHOOK_NO_TOKEN",
        a2a_transfer: false,
        message: "payment topic: error inesperado resolviendo token del negocio",
        data: { resolvedBusinessId, mpOrderId },
      });
      return { kind: "early", response: NextResponse.json({ ok: true, ignored: "no_token" }) };
    }

    return { kind: "token", accessToken: tokenResult };
  }

  // merchant_order (QR in-store) — per-business token preferred (WS1-B).
  // The QR was PUT under the business's collector user_id; calling
  // GET /merchant_orders/{id} with a different account's token returns 403.
  // Falls back to the central env token only when the business has no
  // MpConnection row (legacy single-seller / demo path).
  if (businessIdFromQuery) {
    const tokenResult = await getMpTokenForBusiness(businessIdFromQuery);

    if (tokenResult === MP_TOKEN_EXPIRED) {
      cloudLog({
        severity: "ERROR",
        component: "System",
        action: "MP_WEBHOOK_MERCHANT_ORDER_TOKEN_EXPIRED",
        a2a_transfer: false,
        message: "merchant_order: token del negocio expirado — no se puede verificar el merchant_order",
        data: { businessIdFromQuery, mpOrderId },
      });
      return {
        kind: "early",
        response: NextResponse.json({ ok: true, ignored: "business_mp_token_expired" }),
      };
    }
    if (tokenResult === MP_TOKEN_DECRYPT_ERROR) {
      cloudLog({
        severity: "ERROR",
        component: "System",
        action: "MP_WEBHOOK_MERCHANT_ORDER_DECRYPT_ERROR",
        a2a_transfer: false,
        message: "merchant_order: error descifrando token del negocio",
        data: { businessIdFromQuery, mpOrderId },
      });
      return {
        kind: "early",
        response: NextResponse.json({ ok: true, ignored: "business_mp_token_decrypt_error" }),
      };
    }
    if (tokenResult && tokenResult !== MP_TOKEN_NOT_CONNECTED) {
      // Per-business token resolved successfully — use it.
      return { kind: "token", accessToken: tokenResult };
    }
    // tokenResult is MP_TOKEN_NOT_CONNECTED or null — fall through to central env.
    if (tokenResult === null) {
      cloudLog({
        severity: "WARNING",
        component: "System",
        action: "MP_WEBHOOK_MERCHANT_ORDER_TOKEN_ERROR",
        a2a_transfer: false,
        message: "merchant_order: error inesperado resolviendo token del negocio — intentando central",
        data: { businessIdFromQuery, mpOrderId },
      });
    }
    // MP_TOKEN_NOT_CONNECTED: business never connected MP — fall through to env.
  }

  // Central env fallback: used when ?businessId= is absent, or business has
  // no MpConnection (MP_TOKEN_NOT_CONNECTED — single-seller / demo path).
  const centralToken = await getMpAccessToken(null);
  if (!centralToken) {
    cloudLog({
      severity: "ERROR",
      component: "System",
      action: "MP_WEBHOOK_NO_TOKEN",
      a2a_transfer: false,
      message: "MP webhook recibido pero no hay access token (central ni per-business) configurado",
      data: { businessIdFromQuery, mpOrderId },
    });
    return { kind: "early", response: NextResponse.json({ ok: true, ignored: "no_token" }) };
  }

  return { kind: "token", accessToken: centralToken };
}
