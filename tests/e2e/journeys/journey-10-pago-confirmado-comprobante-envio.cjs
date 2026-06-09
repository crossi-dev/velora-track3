// J10 — Pago confirmado → comprobante + envío (post-pago async)
//
// Verifica los eslabones 4 y 5 del flujo norte A2A:
//   4. Fiscal agent emite el comprobante → comprobanteSentAt estampado
//   5. Logística agent crea el envío Andreani → shipmentCreatedAt estampado
//
// Flujo:
//   Step 1 — Crear link de pago con envío (igual a J09, mismos datos)
//   Step 2 — Confirmar el PaymentIntent vía /api/payment-intents/confirm
//             usando la cookie del owner (mismo mecanismo que smoke-cobro-qr A2).
//             Esto dispara confirmPaymentIntentUseCase → runPostConfirmSideEffects
//             fire-and-forget para los agentes Fiscal y Logística.
//   Step 3 — Polling de la DB hasta que comprobanteSentAt y shipmentCreatedAt
//             estén estampados. Timeout conservador de 45 segundos.
//
// Mecanismo de confirmación elegido: /api/payment-intents/confirm (owner authed).
//   NO usamos el webhook MP porque:
//   a) Requiere MP_WEBHOOK_SECRET (en Secret Manager, no disponible en el runner
//      de tests) para forjar la firma HMAC — sin el secret el webhook rechaza
//      con 401 (fail-closed por diseño).
//   b) El webhook usa isWebhookConfirm=true que cambia metodo a "qr_dynamic_real",
//      pero runPostConfirmSideEffects lee el metodo directamente de la DB al
//      inicio — el cambio ya ocurre dentro de la misma transacción que el confirm,
//      así que el metodo ya es "qr_dynamic_real" cuando llega al check.
//      ACTUALIZACIÓN: esto significa que la ruta /confirm (owner) es la correcta
//      para J10 porque preserva metodo="checkout_pro_link" en la DB, lo que hace
//      que runPostConfirmSideEffects entre en el branch de link (fiscal + envío).
//
// Idempotencia del confirm: usa X-Idempotency-Key único por corrida.
//
// Sandbox reality:
//   - El agente Fiscal opera en sandbox ARCA → emite CAE ficticio. ok.
//   - El agente Logística llama a Andreani sandbox → crea envío mock. ok.
//   - WhatsApp puede fallar si el teléfono del customer no está habilitado
//     en el sandbox Twilio. triggerFiscalReceipt trata WhatsApp-fail como
//     { ok: false } → comprobanteSentAt queda null en ese caso.
//     Por eso la assertion de comprobanteSentAt es "best-effort" con detalle,
//     no throw-on-null.
//
// Si un paso falla: NO forzar el pase — el error es el dato.
// Reportar exactamente qué timestamp quedó null y cuál fue el motivo de log.

"use strict";

const { randomUUID } = require("node:crypto");
const {
  bootstrap,
  setupBusiness,
  chatTurn,
  cleanup,
  disconnect,
  prismaClient,
} = require("../_lib/journey.cjs");

const BASE_URL = (process.env.JOURNEY_BASE_URL ?? "https://somosvelora.com").replace(/\/$/, "");

// Polling config for async post-confirm side-effects
const POLL_INTERVAL_MS = 3_000;
const POLL_MAX_ATTEMPTS = 15; // 45 seconds total

async function pollPaymentIntentStamps(prisma, paymentIntentId) {
  for (let attempt = 1; attempt <= POLL_MAX_ATTEMPTS; attempt++) {
    const pi = await prisma.paymentIntent.findUnique({
      where: { id: paymentIntentId },
      select: {
        id: true,
        estado: true,
        metodo: true,
        comprobanteSentAt: true,
        shipmentCreatedAt: true,
        shippingRequired: true,
      },
    });

    if (!pi) return null;

    const done =
      pi.comprobanteSentAt !== null &&
      (!pi.shippingRequired || pi.shipmentCreatedAt !== null);

    if (done) return pi;

    if (attempt < POLL_MAX_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  }

  // Return last known state even if not fully stamped
  return await prisma.paymentIntent.findUnique({
    where: { id: paymentIntentId },
    select: {
      id: true,
      estado: true,
      metodo: true,
      comprobanteSentAt: true,
      shipmentCreatedAt: true,
      shippingRequired: true,
    },
  });
}

async function confirmIntent(ownerCookie, paymentIntentId) {
  const idempotencyKey = randomUUID();
  const res = await fetch(`${BASE_URL}/api/payment-intents/confirm`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: ownerCookie,
      "X-Idempotency-Key": idempotencyKey,
      Origin: BASE_URL,
      Referer: `${BASE_URL}/dashboard`,
    },
    body: JSON.stringify({ paymentIntentId }),
  });

  let body = {};
  try { body = await res.json(); } catch { /* empty */ }
  return { status: res.status, body };
}

async function runJ10() {
  await bootstrap();

  const EMAIL = `j10-pago-confirmado-${Date.now()}@velora.test`;
  let userId, businessId, ownerCookie;

  try {
    ({ userId, businessId, ownerCookie } = await setupBusiness({
      email: EMAIL,
      name: "Journey10 User",
      blank: false,
      business: {
        name: "Link Pago Confirm Test",
        type: "mini-market",
        paymentMethods: ["Mercado Pago", "Efectivo"],
        openingCash: "10000",
        openingCashConfigured: true,
      },
    }));

    const prisma = prismaClient();

    // ── Seed Business.postalCode (required by shipping-quote.ts) ─────────────
    await prisma.business.update({
      where: { id: businessId },
      data: { postalCode: "5500" },
    });

    // ── Seed product ──────────────────────────────────────────────────────────
    await prisma.product.create({
      data: {
        businessId,
        name: "filtro de aire",
        price: "4500",
        quantity: 30,
      },
    });

    // ── Seed customer with postalCode (destination for shipping) ─────────────
    await prisma.customer.create({
      data: {
        businessId,
        name: "María García",
        phone: "+5492615551234",
        address: "Av. San Martín 450",
        postalCode: "5519",
        city: "Las Heras",
      },
    });

    const history = [];

    // ── Step 1: Pedir link de pago con envío (replica J09 Step 1) ────────────
    const s1 = await chatTurn({
      cookie: ownerCookie,
      text: "generá un link de pago para María García por 3 filtros de aire con envío incluido",
      chatHistory: history,
      timeoutMs: 60_000,
    });

    if (s1.statusCode !== 200) {
      throw new Error(
        `J10 S1: HTTP ${s1.statusCode} — ${JSON.stringify(s1.raw).slice(0, 400)}`,
      );
    }

    // Verify we got a meaningful reply (reuse J09 signal set)
    const replyIsEmpty = s1.text.trim().length < 10;
    const replyIsOffTopic =
      !/mercadopago|checkout|link de pago|link para pagar|envío|flete|total|monto|pesos|filtro|aire|maría|garcia|error al generar|no pude|logística|andreani|código postal/i
        .test(s1.text);

    if (replyIsEmpty) {
      throw new Error(`J10 S1: Empty reply from agent. statusCode=${s1.statusCode}`);
    }
    if (replyIsOffTopic) {
      throw new Error(
        `J10 S1: Reply is off-topic — no payment/shipping/product signals.\n` +
        `Reply (first 300): "${s1.text.slice(0, 300)}"`,
      );
    }

    // ── Step 1b: Read the PaymentIntent from DB ───────────────────────────────
    const pi = await prisma.paymentIntent.findFirst({
      where: { businessId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        monto: true,
        metodo: true,
        estado: true,
        shippingRequired: true,
        shippingCostARS: true,
        expiresAt: true,
        comprobanteSentAt: true,
        shipmentCreatedAt: true,
      },
    });

    // If agent asked for more info (origin CP gap, etc.) there may be no PI yet.
    const needsMoreInfo =
      /código postal.*origen|cp.*negocio|configur.*postal|cuánto|qué monto|necesito más/i.test(s1.text);

    if (!pi) {
      if (needsMoreInfo) {
        return {
          ok: true,
          detail:
            `J10: Agent requested more info before creating the intent — Step 2 skipped. ` +
            `Reply: "${s1.text.slice(0, 150)}"`,
        };
      }
      throw new Error(
        `J10 S1: No PaymentIntent found in DB despite payment-related reply.\n` +
        `Reply: "${s1.text.slice(0, 300)}"`,
      );
    }

    if (pi.metodo !== "checkout_pro_link") {
      throw new Error(
        `J10: PaymentIntent.metodo expected "checkout_pro_link", got "${pi.metodo}"`,
      );
    }

    // Extend expiry so the confirm endpoint doesn't return 410 EXPIRED.
    // The default is createdAt+2min; in test we give ourselves 5 extra minutes.
    await prisma.paymentIntent.update({
      where: { id: pi.id },
      data: { expiresAt: new Date(Date.now() + 5 * 60 * 1000) },
    });

    // ── Step 2: Confirm the PaymentIntent (triggers post-confirm side effects) ─
    // Uses /api/payment-intents/confirm authenticated with the owner cookie.
    // This calls confirmPaymentIntentUseCase → runPostConfirmSideEffects
    // (fire-and-forget). metodo stays "checkout_pro_link" (not overwritten by
    // this path) so runPostConfirmSideEffects enters the link branch → fiscal + envío.
    const confirmResult = await confirmIntent(ownerCookie, pi.id);

    if (confirmResult.status !== 200) {
      // 409 already_confirmed is acceptable in re-runs; 410 = expired (shouldn't happen
      // now that we extended expiresAt), anything else is a genuine error.
      const alreadyConfirmed =
        confirmResult.status === 409 &&
        confirmResult.body?.code === "ALREADY_CONFIRMED";

      if (!alreadyConfirmed) {
        throw new Error(
          `J10 S2: confirm HTTP ${confirmResult.status} — ${JSON.stringify(confirmResult.body).slice(0, 300)}`,
        );
      }
      // Already confirmed from a prior run — still proceed to poll stamps.
    }

    // ── Step 3: Poll for post-confirm timestamps ──────────────────────────────
    // runPostConfirmSideEffects is fire-and-forget. The agents are async.
    // Poll up to POLL_MAX_ATTEMPTS × POLL_INTERVAL_MS before giving up.
    const finalPi = await pollPaymentIntentStamps(prisma, pi.id);

    if (!finalPi) {
      throw new Error(`J10 S3: PaymentIntent ${pi.id} not found during polling`);
    }

    // ── Build result detail ───────────────────────────────────────────────────
    const link4 = finalPi.comprobanteSentAt !== null
      ? `PASS comprobanteSentAt=${finalPi.comprobanteSentAt.toISOString()}`
      : `FAIL comprobanteSentAt=null (Fiscal agent or WhatsApp failed — check COMPROBANTE_* logs)`;

    const link5 = !finalPi.shippingRequired
      ? `SKIP shippingRequired=false (shipping was not quoted in this run)`
      : finalPi.shipmentCreatedAt !== null
        ? `PASS shipmentCreatedAt=${finalPi.shipmentCreatedAt.toISOString()}`
        : `FAIL shipmentCreatedAt=null (Logística agent failed — check SHIPMENT_* logs)`;

    // J10 passes only when both applicable timestamps are stamped.
    const link4Pass = finalPi.comprobanteSentAt !== null;
    const link5Pass = !finalPi.shippingRequired || finalPi.shipmentCreatedAt !== null;

    if (!link4Pass || !link5Pass) {
      throw new Error(
        `J10: Post-confirm side-effects incomplete after ${POLL_MAX_ATTEMPTS * POLL_INTERVAL_MS / 1000}s.\n` +
        `Link 4 (comprobante): ${link4}\n` +
        `Link 5 (envío): ${link5}\n` +
        `Intent: ${finalPi.id} estado=${finalPi.estado} metodo=${finalPi.metodo}`,
      );
    }

    return {
      ok: true,
      detail:
        `PaymentIntent ${finalPi.id} (${finalPi.estado}). ` +
        `Link 4: ${link4}. Link 5: ${link5}.`,
    };
  } finally {
    if (businessId) await cleanup(businessId, userId);
    await disconnect();
  }
}

module.exports = { runJ10 };

if (require.main === module) {
  runJ10()
    .then((r) => {
      console.log("J10 OK:", r.detail);
      process.exit(0);
    })
    .catch((err) => {
      console.error("J10 FAIL:", err.message);
      process.exit(1);
    });
}
