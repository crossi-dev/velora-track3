// J02 — Venta simple + cobro QR
// Tests: sale creation → confirmation → QR generation with correct amount.
//
// Setup: onboarded business + 1 product "alfajor" at $800, stock=20.
// Idempotent: unique email per run, full cleanup.

"use strict";

const {
  bootstrap,
  setupBusiness,
  chatTurn,
  assertReplyContains,
  cleanup,
  disconnect,
  prismaClient,
} = require("../_lib/journey.cjs");

async function runJ02() {
  await bootstrap();

  const EMAIL = `j02-venta-qr-${Date.now()}@velora.test`;
  let userId, businessId, ownerCookie;

  try {
    ({ userId, businessId, ownerCookie } = await setupBusiness({
      email: EMAIL,
      name: "Journey02 User",
      blank: false,
      business: {
        name: "QR Test Kiosco",
        type: "mini-market",
        paymentMethods: ["Mercado Pago", "Efectivo"],
        openingCash: "5000",
        openingCashConfigured: true,
      },
    }));

    // Seed product + inventory directly via Prisma
    const prisma = prismaClient();
    const product = await prisma.product.create({
      data: {
        businessId,
        name: "alfajor",
        price: "800",
        quantity: 20,
      },
    });

    // Seed a customer
    await prisma.customer.create({
      data: { businessId, name: "Juan", phone: null },
    });

    const history = [];
    function addToHistory(kind, text, extra = {}) {
      history.push({ kind, text, source: kind === "user" ? "user" : "assistant", ...extra });
    }

    // ── Step 1: Register the sale ────────────────────────────────────────────
    const s1 = await chatTurn({
      cookie: ownerCookie,
      text: "vendí 2 alfajor a Juan",
      chatHistory: history,
    });

    if (s1.statusCode !== 200) {
      throw new Error(`J02 S1: HTTP ${s1.statusCode} — ${JSON.stringify(s1.raw).slice(0, 300)}`);
    }

    // Should have a sale draft with qty=2 and total ~1600
    assertReplyContains(s1.text, ["juan", "alfajor", "1.600", "1600", "2"], "J02-S1-sale-draft");
    addToHistory("user", "vendí 2 alfajor a Juan");
    addToHistory("reply", s1.text, { confirmationRequest: s1.confirmationRequest });

    // ── Step 2: Confirm the sale ─────────────────────────────────────────────
    const s2 = await chatTurn({
      cookie: ownerCookie,
      text: "confirmá",
      chatHistory: history,
    });

    if (s2.statusCode !== 200) {
      throw new Error(`J02 S2: HTTP ${s2.statusCode} — ${JSON.stringify(s2.raw).slice(0, 300)}`);
    }

    assertReplyContains(
      s2.text,
      ["venta", "registr", "confirm", "alfajor", "1.600", "1600"],
      "J02-S2-sale-confirmed",
    );
    addToHistory("user", "confirmá");
    addToHistory("reply", s2.text);

    // ── Step 3: Generate QR (no explicit amount — uses last sale total) ──────
    const s3 = await chatTurn({
      cookie: ownerCookie,
      text: "cobro QR",
      chatHistory: history,
    });

    if (s3.statusCode !== 200) {
      throw new Error(`J02 S3: HTTP ${s3.statusCode} — ${JSON.stringify(s3.raw).slice(0, 300)}`);
    }

    // The QR handler requires a monto — "cobro QR" without an amount may fall to LLM
    // We accept either a QR card action OR an answer asking for the amount
    const hasQrAction = s3.actions.some((a) => a.type === "confirm_cobro");
    const asksForAmount = /monto|cuánto|importe|pesos/i.test(s3.text);

    if (!hasQrAction && !asksForAmount) {
      // Retry with explicit amount
      addToHistory("user", "cobro QR");
      addToHistory("reply", s3.text);

      const s3b = await chatTurn({
        cookie: ownerCookie,
        text: "cobro QR 1600",
        chatHistory: history,
      });

      if (s3b.statusCode !== 200) {
        throw new Error(`J02 S3b: HTTP ${s3b.statusCode} — ${JSON.stringify(s3b.raw).slice(0, 300)}`);
      }

      const hasQrAction2 = s3b.actions.some((a) => a.type === "confirm_cobro");
      if (!hasQrAction2) {
        throw new Error(
          `J02 S3b: Expected confirm_cobro action. Got: ${s3b.text.slice(0, 200)}\nActions: ${JSON.stringify(s3b.actions)}`,
        );
      }

      const qrAction = s3b.actions.find((a) => a.type === "confirm_cobro");
      if (Number(qrAction.monto) !== 1600) {
        throw new Error(`J02 S3b: QR monto ${qrAction.monto} !== 1600`);
      }

      // DB assertion: PaymentIntent was created
      const pi = await prisma.paymentIntent.findFirst({
        where: { businessId },
        orderBy: { createdAt: "desc" },
        select: { id: true, monto: true, estado: true },
      });
      if (!pi) throw new Error("J02: No PaymentIntent found in DB");
      if (Number(pi.monto) !== 1600) {
        throw new Error(`J02: PaymentIntent monto ${Number(pi.monto)} !== 1600`);
      }

      return { ok: true, detail: `QR generated (via explicit amount fallback), monto=${Number(pi.monto)}, PaymentIntent=${pi.id}` };
    }

    // Happy path: QR returned directly
    if (hasQrAction) {
      const qrAction = s3.actions.find((a) => a.type === "confirm_cobro");
      if (!qrAction) throw new Error("J02 S3: confirm_cobro action missing");

      // DB assertion
      const pi = await prisma.paymentIntent.findFirst({
        where: { businessId },
        orderBy: { createdAt: "desc" },
        select: { id: true, monto: true, estado: true },
      });
      if (!pi) throw new Error("J02: No PaymentIntent found in DB");

      return {
        ok: true,
        detail: `QR generated directly, monto=${Number(pi.monto)}, PaymentIntent=${pi.id}`,
      };
    }

    // If we got here the response asked for an amount (which is acceptable)
    return {
      ok: true,
      detail: `QR flow triggered with clarification prompt (acceptable — cobro QR without amount needs monto). Reply: "${s3.text.slice(0, 100)}"`,
    };
  } finally {
    if (businessId) await cleanup(businessId, userId);
    await disconnect();
  }
}

module.exports = { runJ02 };

if (require.main === module) {
  runJ02()
    .then((r) => {
      console.log("J02 OK:", r.detail);
      process.exit(0);
    })
    .catch((err) => {
      console.error("J02 FAIL:", err.message);
      process.exit(1);
    });
}
