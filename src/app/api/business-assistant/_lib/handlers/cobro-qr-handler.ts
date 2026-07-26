// Handler del intent `cobro_qr`.
// Modos: "qr" → QR placeholder + botón "Marcar cobrado".
//        "alias" → alias MP/CVU del dueño + "Marcar cobrado".
// Idempotencia: UUID por turno; la use-case devuelve "replayed" en retries sin duplicar.

import { NextResponse } from "next/server";
import { createHash, randomUUID } from "crypto";
import { cloudLog } from "@/lib/cloud-logger";
import { createPaymentIntentUseCase } from "@/app/api/payment-intents/_lib/payment-intent-use-case";
import { attemptRealQrWithReason } from "./cobro-qr-real";
import type { CobroQrIntent } from "../nlu/types";
import type { PreModelIntentParams } from "../router-params";

function buildIdempotencyKey(
  businessId: string,
  actorEmployeeId: string | null,
  metodo: string,
  monto: number,
  matchedCustomerId: string | null,
  turnId: string,
): string {
  const raw = [
    businessId,
    actorEmployeeId ?? "owner",
    metodo,
    String(monto),
    matchedCustomerId ?? "no-customer",
    turnId,
  ].join("|");
  return createHash("sha256").update(raw).digest("hex").slice(0, 32);
}

export async function executeCobroQr(
  intent: CobroQrIntent,
  params: PreModelIntentParams,
): Promise<NextResponse> {
  // cobro_qr is allowed for both owner and employee — employees are the
  // primary point-of-sale actors. RBAC gate was removed 2026-05-11.
  // Defense-in-depth: role-contract.ts lists "cobro_qr" in EMPLOYEE_ALLOWED_INTENTS;
  // gateIntentByRole() enforces this at the chat layer before we arrive here.

  // UUID por turno: la use-case hace insert-or-replay por idempotencyKey, así
  // que si el mismo chat turn llega dos veces (retry de red) devuelve el mismo
  // PaymentIntent sin crear duplicados.
  const turnId = randomUUID();

  if (!Number.isFinite(intent.monto) || intent.monto < 1) {
    return NextResponse.json({
      answer:
        intent.metodo === "alias"
          ? 'No entendí el monto del cobro alias. Probá: "cobro alias 5000".'
          : 'No entendí el monto del cobro. Probá: "cobro 5000" o "qr 5000 a Carlos".',
    });
  }

  const { prisma } = await import("@/lib/prisma");
  const business = await prisma.business.findUnique({
    where: { id: params.businessId },
    select: { userId: true, alias: true },
  });
  const actorUserId = business?.userId ?? "";
  if (!actorUserId) {
    cloudLog({
      severity: "ERROR",
      component: "System",
      action: "COBRO_QR_NO_OWNER",
      a2a_transfer: false,
      message: "cobro_qr: business sin owner userId",
      businessId: params.businessId,
    });
    return NextResponse.json({
      answer: "No pude armar el cobro ahora. Probá de nuevo en un toque.",
    });
  }

  if (intent.metodo === "alias") {
    const alias = (business?.alias ?? "").trim();
    if (!alias) {
      return NextResponse.json({
        answer:
          "Configurá tu alias en Ajustes primero. Andá a Ajustes → Negocio y agregá tu alias MP/CVU para cobrar por transferencia.",
      });
    }
    return runCreate(intent, params, actorUserId, "alias_personal", alias, turnId);
  }

  return runCreate(intent, params, actorUserId, "qr_dynamic_fake", null, turnId);
}

async function runCreate(
  intent: CobroQrIntent,
  params: PreModelIntentParams,
  actorUserId: string,
  metodoServer: "qr_dynamic_fake" | "qr_dynamic_real" | "alias_personal",
  alias: string | null,
  turnId: string,
): Promise<NextResponse> {
  const idempotencyKey = buildIdempotencyKey(
    params.businessId,
    params.actorEmployeeId,
    metodoServer,
    intent.monto,
    intent.matchedCustomerId,
    turnId,
  );

  try {
    const result = await createPaymentIntentUseCase({
      businessId: params.businessId,
      actorUserId,
      actorEmployeeId: params.actorEmployeeId,
      saleId: null,
      monto: intent.monto,
      metodo: metodoServer,
      idempotencyKey,
      matchedCustomerId: intent.matchedCustomerId,
    });

    if (result.outcome === "replayed") {
      const replayed = result.body as {
        paymentIntentId?: string;
        monto?: number;
        qrPlaceholderUrl?: string;
        expiresAt?: string | null;
      };
      return buildResponse(
        intent.metodo,
        replayed.paymentIntentId ?? "",
        Number(replayed.monto ?? intent.monto),
        replayed.qrPlaceholderUrl ?? "/static/qr-placeholder.svg",
        alias,
        replayed.expiresAt ?? null,
        intent.matchedCustomerId,
        intent.customerName,
        null,
        null,
      );
    }
    if (result.outcome !== "created") {
      cloudLog({
        severity: "WARNING",
        component: "System",
        action: "COBRO_QR_USE_CASE_NOT_CREATED",
        a2a_transfer: false,
        message: `cobro_qr: outcome ${result.outcome}`,
        businessId: params.businessId,
        data: { outcome: result.outcome, metodo: intent.metodo },
      });
      return NextResponse.json({
        answer: "El cobro ya está en curso. Esperá un toque y reintentalo si hace falta.",
      });
    }

    // Employee onboarding-task tracking removed (0 rows in production, Stage 1 cleanup).

    // Intent ya creado en DB (estado pending, metodo "qr_dynamic_fake"). Si el
    // flag MP_REAL_QR_ENABLED está activo, intentamos crear el QR real en MP
    // ahora y enriquecemos la respuesta. Falla del QR real es no-fatal — la
    // card sigue funcionando con el placeholder y el empleado puede "marcar
    // cobrado" manualmente (camino fake intacto).
    //
    // WS1-B: attemptRealQrWithReason devuelve el motivo explícito cuando el
    // negocio tiene MP conectado pero hay un problema de configuración (ej: POS
    // no configurado, token expirado). En ese caso el answer menciona el problema
    // para que el dueño pueda actuar, en vez del genérico "QR de sandbox".
    const { qrSvgDataUrl, blockedMessage } = intent.metodo === "qr"
      ? await tryRealQr(params.businessId, result.intent.paymentIntentId, result.intent.monto, result.intent.expiresAt)
      : { qrSvgDataUrl: null, blockedMessage: null };

    return buildResponse(
      intent.metodo,
      result.intent.paymentIntentId,
      result.intent.monto,
      result.intent.qrPlaceholderUrl,
      alias,
      result.intent.expiresAt,
      intent.matchedCustomerId,
      intent.customerName,
      qrSvgDataUrl,
      blockedMessage,
    );
  } catch (error) {
    cloudLog({
      severity: "ERROR",
      component: "System",
      action: "COBRO_QR_HANDLER_ERROR",
      a2a_transfer: false,
      message: "cobro_qr: handler error",
      businessId: params.businessId,
      data: {
        error: error instanceof Error ? error.message : String(error),
        metodo: intent.metodo,
      },
    });
    return NextResponse.json({
      answer: "No pude armar el cobro ahora. Probá de nuevo en un toque.",
    });
  }
}

async function tryRealQr(
  businessId: string,
  paymentIntentId: string,
  monto: number,
  expiresAtIso: string | null,
): Promise<{ qrSvgDataUrl: string | null; blockedMessage: string | null }> {
  // expiresAt canónico viene de la use-case (= lo que está en DB).
  // Si la use-case no devolvió expiresAt (rows legacy sin expiresAt) la ruta
  // real QR no puede correr; devolvemos null y la card usa el placeholder.
  if (!expiresAtIso) return { qrSvgDataUrl: null, blockedMessage: null };
  const expiresAt = new Date(expiresAtIso);
  const { result, blocked } = await attemptRealQrWithReason({ businessId, paymentIntentId, monto, expiresAt });
  return {
    qrSvgDataUrl: result?.qrSvgDataUrl ?? null,
    blockedMessage: blocked?.userMessage ?? null,
  };
}

function buildResponse(
  metodo: "qr" | "alias",
  paymentIntentId: string,
  monto: number,
  qrPlaceholderUrl: string,
  alias: string | null,
  expiresAt: string | null,
  matchedCustomerId: string | null,
  customerName: string | null,
  qrSvgDataUrl: string | null,
  blockedMessage: string | null,
): NextResponse {
  const customerSuffix = customerName ? ` para ${customerName}` : "";
  const qrIsReal = qrSvgDataUrl !== null;
  // If the business has MP connected but something is wrong (POS not configured,
  // token expired), surface the specific actionable message instead of the generic
  // sandbox notice. The PaymentIntent is still created — "marcar cobrado" still works.
  const sandboxNotice = qrIsReal
    ? ""
    : blockedMessage
      ? ` ⚠️ ${blockedMessage}`
      : " Para cobrar por QR real necesitás conectar tu cuenta de Mercado Pago. Andá a Ajustes → Pagos para conectarla. Por ahora este QR es de sandbox y no procesa un pago real.";
  const answer =
    metodo === "alias"
      ? `Decile al cliente que transfiera $${monto} al alias ${alias}${customerSuffix}. Cuando llegue, tocá "Marcar cobrado".`
      : qrIsReal
        ? `QR listo por $${monto}${customerSuffix}. Cuando el cliente pague, tocá "Marcar cobrado".`
        : `Generé un cobro de $${monto}${customerSuffix}.${sandboxNotice} Tocá "Marcar cobrado" cuando el cliente pague.`;
  // qrSvgDataUrl tiene precedencia sobre qrPlaceholderUrl en la card client.
  // Si MP API respondió OK, la imagen es el QR real; si falló, queda el placeholder.
  const effectiveQrUrl = qrSvgDataUrl ?? qrPlaceholderUrl;

  // When QR is sandbox (MP not configured), surface a "Conectar MP" CTA chip
  // so the owner can navigate to Settings → Payments in one tap.
  const chips =
    metodo === "qr" && !qrIsReal
      ? {
          kind: "single" as const,
          options: [
            {
              label: "Conectar Mercado Pago",
              value: "navigate:/dashboard?tab=servicios",
            },
          ],
        }
      : undefined;

  return NextResponse.json({
    answer,
    ...(chips ? { chips } : {}),
    actions: [
      {
        type: "confirm_cobro",
        metodo,
        paymentIntentId,
        monto,
        qrPlaceholderUrl: effectiveQrUrl,
        qrIsReal,
        // sandbox flag: UI can render a visible "Sandbox" badge on the QR card
        // when credentials are not configured. Absent (undefined) on real QRs.
        sandbox: qrIsReal ? undefined : true,
        alias,
        // Slice 3 — Timeout 2 min: el cliente arma el countdown desde acá.
        expiresAt,
        matchedCustomerId,
        customerName,
      },
    ],
  });
}
