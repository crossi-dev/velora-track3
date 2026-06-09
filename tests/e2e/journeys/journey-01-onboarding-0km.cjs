// J01 — Onboarding 0km
// Tests the full conversational onboarding flow (post distribuidora-ready):
//   business name → type → payment methods → postal code → courier → WhatsApp →
//   product load mode → first product → stock quantity → done.
//
// Opening-cash turn was removed in the distribuidora-ready expansion (2026-05).
// Idempotent: creates a unique-per-run email, wipes on cleanup.

"use strict";

const {
  bootstrap,
  setupBusiness,
  chatTurn,
  assertBusinessState,
  assertReplyContains,
  cleanup,
  disconnect,
  prismaClient,
} = require("../_lib/journey.cjs");

async function runJ01() {
  await bootstrap();

  const EMAIL = `j01-onboarding-${Date.now()}@velora.test`;
  let userId, businessId, ownerCookie;

  try {
    // ── Setup: blank business (onboarding not started) ──────────────────────
    ({ userId, businessId, ownerCookie } = await setupBusiness({
      email: EMAIL,
      name: "Journey01 User",
      blank: true,
    }));

    const history = [];

    function addToHistory(kind, text) {
      history.push({ kind, text, source: kind === "user" ? "user" : "assistant" });
    }

    async function turn(message, expectedPatterns, stepLabel) {
      const result = await chatTurn({
        cookie: ownerCookie,
        text: message,
        chatHistory: history,
      });

      if (result.statusCode !== 200) {
        throw new Error(
          `${stepLabel}: HTTP ${result.statusCode}. Body: ${JSON.stringify(result.raw).slice(0, 300)}`,
        );
      }

      if (expectedPatterns && expectedPatterns.length > 0) {
        assertReplyContains(result.text, expectedPatterns, stepLabel);
      }

      addToHistory("user", message);
      addToHistory("reply", result.text);

      return result;
    }

    // ── Step 2: Business name ────────────────────────────────────────────────
    const s2 = await turn("Maxi Kiosco", ["maxi kiosco", "maxikiosco"], "T1-name");

    // ── Step 3: Business type ────────────────────────────────────────────────
    // After the type is accepted the onboarding asks about payment methods.
    // Actual prod reply: "¿Cómo cobrás? Tocá los que uses y dale a Listo."
    const s3 = await turn("Mini-market", ["cobrás", "cobro", "pago", "método", "efectivo", "listo", "tocá"], "T2-type");

    // ── Step 4: Payment methods ──────────────────────────────────────────────
    // After payment methods the NEW flow asks for the business postal code (T4).
    const s4 = await turn("Mercado Pago", ["código postal", "cp", "postal", "dígitos", "negocio"], "T3-payment");

    // ── Step 5: Postal code ─────────────────────────────────────────────────
    // System asks for the 4-5 digit postal code (logistics origin for Andreani).
    const s5 = await turn("5500", ["correo", "courier", "andreani", "oca", "envío", "envios", "hacés envíos", "despacho"], "T4-postal-code");

    // ── Step 6: Courier preference ──────────────────────────────────────────
    const s6 = await turn("Andreani", ["whatsapp", "teléfono", "celular", "negocio", "número", "más tarde", "ingresarlo"], "T5-courier");

    // ── Step 7: WhatsApp ─────────────────────────────────────────────────────
    const s7 = await turn("Más tarde", ["cargar", "producto", "foto", "mano", "pegar", "nombre", "precio"], "T6-whatsapp");

    // ── Step 8: Product load method ──────────────────────────────────────────
    const s8 = await turn("escribir a mano", ["nombre", "precio", "producto", "cargar"], "T7-method");

    // ── Step 9: First product name+price ────────────────────────────────────
    const s9 = await turn("alfajor 800", ["cuántas", "unidades", "stock", "cantidad"], "T7b-product");

    // ── Step 10: Quantity ─────────────────────────────────────────────────────
    // After the stock quantity is accepted the fast path clears pendingStockProductId
    // and asks "¿Cargás otro producto o ya está?" — onboarding is structurally complete
    // at this point (business name + type + payment + postalCode + courier + whatsApp +
    // product + stock all set). The journey ends here; DB assertions validate state.
    const s10 = await turn("10", ["10", "agregad", "otro", "cargás", "ya está", "unidades"], "T7c-quantity");

    // ── DB assertions ────────────────────────────────────────────────────────
    const biz = await assertBusinessState({
      businessId,
      name: "Maxi Kiosco",
      type: "mini-market",
      paymentMethodsInclude: ["Mercado Pago"],
      productCountMin: 1,
      inventoryQuantityMin: 10,
    });

    // Double-check inventory specifically
    const prisma = prismaClient();
    const product = await prisma.product.findFirst({
      where: { businessId },
      select: { id: true, name: true, price: true, quantity: true },
    });
    if (!product) throw new Error("J01: No product found after onboarding");
    const qty = product.quantity ? Number(product.quantity) : 0;
    if (qty < 10) throw new Error(`J01: Inventory quantity ${qty} < 10`);

    return { ok: true, detail: `Business "${biz.name}" created with 1 product (qty=${qty})` };
  } finally {
    if (businessId) await cleanup(businessId, userId);
    await disconnect();
  }
}

// ── Export + direct run support ───────────────────────────────────────────────
module.exports = { runJ01 };

if (require.main === module) {
  runJ01()
    .then((r) => {
      console.log("J01 OK:", r.detail);
      process.exit(0);
    })
    .catch((err) => {
      console.error("J01 FAIL:", err.message);
      process.exit(1);
    });
}
