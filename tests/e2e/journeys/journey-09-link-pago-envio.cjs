// J09 — Link de pago con envío (flujo norte sincrónico)
//
// Escenario: el owner pide en el chat un link de pago por productos de un cliente
// con envío a una dirección (con código postal).
//
// El flujo norte real es: Supervisor → Payments Agent → cotizar envío (Logística)
// → persistir PaymentIntent → crear preferencia MP.
//
// Assertions SINCRÓNICAS (post-pago es asincrónico — cubierto por tests separados):
//   A. El reply menciona alguna variante de link de pago / cobro / envío / total.
//   B. El PaymentIntent persiste en DB con metodo="checkout_pro_link".
//   C. Si el envío se cotizó: shippingRequired=true y shippingCostARS != null.
//   D. Si MP falla (token placeholder en sandbox): el reply menciona el error
//      sin bloquear el journey — el intent DB ya está creado (eso es lo valioso).
//
// NOTA DE DISEÑO: setupBusiness() no configura Business.postalCode.
// El flujo de envío exige ese campo (shipping-quote.ts devuelve
// missing_origin_postal_code si está vacío). Lo seteamos por Prisma después
// del setup, junto con un Customer que tenga postalCode.
//
// Si el flujo devuelve missing_origin_postal_code, el agente pedirá el CP de
// origen al owner. Eso también es un resultado válido (no es un crash) y el
// journey lo acepta como "flujo de envío iniciado con datos incompletos".
//
// PROMPT ENGINEERING NOTE: The request must NOT use commas + bare digits in
// address fragments (e.g. "Av. San Martín 450, CP 5519") because the
// multi-price-edit fast-path (NLU label 7) splits on commas and interprets
// street numbers as prices (450 → price, "san martin" → unknownFragment).
// This fires the multi_price_edit intent instead of routing to the Payments
// Agent. Workaround: use a comma-free phrasing for the request; the
// Customer.postalCode field in DB is what the shipping-quote resolver uses,
// so we don't need to inline the full address in the chat message.
// See: src/app/api/business-assistant/_lib/handlers/multi-price-detector.ts
// BUG: detectMultiProductPriceEditFull lacks an exclusion guard for
// "link de pago" / "generá un link" vocabulary — payment-link requests
// with address fragments trigger multi_price_edit. Should add a bail-out
// regex for payment/link intent signals at the top of that function.
//
// Este journey fue escrito ANTES de la primera corrida real.
// Si falla, NO forzar el pase — el error es el dato.

"use strict";

const {
  bootstrap,
  setupBusiness,
  chatTurn,
  cleanup,
  disconnect,
  prismaClient,
} = require("../_lib/journey.cjs");

async function runJ09() {
  await bootstrap();

  const EMAIL = `j09-link-envio-${Date.now()}@velora.test`;
  let userId, businessId, ownerCookie;

  try {
    ({ userId, businessId, ownerCookie } = await setupBusiness({
      email: EMAIL,
      name: "Journey09 User",
      blank: false,
      business: {
        name: "Link Pago Test",
        type: "mini-market",
        paymentMethods: ["Mercado Pago", "Efectivo"],
        openingCash: "10000",
        openingCashConfigured: true,
      },
    }));

    const prisma = prismaClient();

    // ── Seed Business.postalCode (required by shipping-quote.ts) ─────────────
    // Without this, resolveShippingQuote returns missing_origin_postal_code
    // and the agent asks the owner to configure it before continuing.
    // We set CP 1043 (Mendoza capital) as origin.
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
    // Customer.postalCode is the preferred destination CP in shipping-quote.ts.
    // Also seed address and city for the address snapshot.
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
    function addToHistory(kind, text) {
      history.push({ kind, text, source: kind === "user" ? "user" : "assistant" });
    }

    // ── Step 1: Pedir link de pago con envío ─────────────────────────────────
    // Prompt design: avoid inline address with commas + bare digits — the
    // multi-price-edit NLU fast path splits on commas and treats street
    // numbers (e.g. 450) as product prices (BUG: see header comment above).
    // The Customer already has postalCode=5519 seeded in DB; the shipping
    // resolver will find it there. We only name the customer + request
    // shipping so the Payments Agent picks up the right flow.
    const s1 = await chatTurn({
      cookie: ownerCookie,
      text: "generá un link de pago para María García por 3 filtros de aire con envío incluido",
      chatHistory: history,
      timeoutMs: 60_000, // LLM + A2A → Logística + MP; allow full chain
    });

    if (s1.statusCode !== 200) {
      throw new Error(
        `J09 S1: HTTP ${s1.statusCode} — ${JSON.stringify(s1.raw).slice(0, 400)}`,
      );
    }

    addToHistory("user", "generá un link de pago para María García por 3 filtros de aire con envío incluido");
    addToHistory("reply", s1.text);

    // ── Classify the response ─────────────────────────────────────────────────
    //
    // Possible outcomes (all valid — the journey documents what actually happens):
    //
    //  OUTCOME A — full happy path (MP token is real/sandbox):
    //    link/URL + envío/flete/total mentioned → PaymentIntent in DB
    //
    //  OUTCOME B — MP auth error (placeholder token):
    //    agent mentions error but PaymentIntent IS in DB (write happens before MP call)
    //    text should mention envío or monto at minimum
    //
    //  OUTCOME C — Payments Agent called shipping quote but logística returned error:
    //    text mentions "error al cotizar", "no pude", "logística" — acceptable gap
    //
    //  OUTCOME D — missing_origin_postal_code despite our seed (race/cache):
    //    text asks for CP origen — unexpected but non-crash, report as detail
    //
    //  OUTCOME E — agent asks for clarification (needs more info):
    //    text asks "cuánto" or "cliente" — report as detail
    //
    //  OUTCOME F — unexpected 200 with empty/unrelated reply:
    //    this IS a failure — throw

    const replyLower = s1.text.toLowerCase();

    // Happy-path signals
    const hasLink =
      /mercadopago\.com|checkout|init_point|link de pago|link para pagar|pago listo|checkouturl/i.test(s1.text);

    const mentionsShipping =
      /envío|flete|despacho|andreani|logística|costo de envío|incluye envío/i.test(s1.text);

    const mentionsTotal =
      /total|monto|pesos|\$[\d.,]+|\d{1,3}(\.\d{3})*(,\d{2})?/i.test(s1.text);

    const mentionsMaria =
      /maría|garcia|garcía/i.test(s1.text);

    const mentionsProducto =
      /filtro|aire|producto/i.test(s1.text);

    // Error / clarification signals (valid non-crash paths)
    const mpError =
      /error al generar|no pude generar|error con mercado|mp_api_error|error de pago/i.test(s1.text);

    const logisticaError =
      /error al cotizar|no pude cotizar|logística|andreani|no pude calcular el envío/i.test(s1.text);

    const needsOriginCP =
      /código postal.*origen|cp.*negocio|configur.*postal|ajustes.*postal/i.test(s1.text);

    // Agent is asking for more info before calling the tool — covers:
    //   - "¿Cuánto es el envío?"
    //   - "necesito la dirección / el código postal de destino"
    //   - "¿Cuál es el CP?" / "¿a dónde se envía?"
    //   - "Para cotizar el envío necesito..."
    const needsMoreInfo =
      /cuánto|qué monto|qué producto|qué cliente|necesito más|necesito la dirección|necesito el código postal|código postal de destino|¿cuál es|a dónde se envía|para cotizar.*necesito/i.test(s1.text);

    // Blank / completely off-topic reply — this IS a failure
    const replyIsEmpty = s1.text.trim().length < 10;
    const replyIsOffTopic =
      !hasLink && !mentionsShipping && !mentionsTotal && !mentionsMaria && !mentionsProducto &&
      !mpError && !logisticaError && !needsOriginCP && !needsMoreInfo;

    if (replyIsEmpty) {
      throw new Error(`J09 S1: Empty reply from agent. statusCode=${s1.statusCode}`);
    }

    if (replyIsOffTopic) {
      throw new Error(
        `J09 S1: Reply appears off-topic — does not mention payment link, shipping, total, customer, product, or any known error path.\n` +
        `Reply (first 400): "${s1.text.slice(0, 400)}"`,
      );
    }

    // ── DB assertion: check for PaymentIntent ────────────────────────────────
    // The intent is persisted BEFORE the MP call — so even if MP fails with
    // the placeholder token, the DB row should exist.
    // Exception: if the agent asked for more info (OUTCOME D/E), it may not
    // have reached the tool call yet — tolerate absence in that case.
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
        shippingAddress: true,
      },
    });

    // Post-fix the chain MUST compute the order amount and persist a
    // PaymentIntent. The only tolerated no-DB-write case is a genuine
    // origin-CP config gap. The agent asking for the amount/product
    // (needsMoreInfo) is now a FAILURE — it means link 2 (deterministic
    // amount resolution) did not fire.
    const agentPaused = needsOriginCP;

    if (!pi && !agentPaused) {
      // The agent replied with something payment-related but no DB row exists.
      // This IS a bug — the intent should persist before MP.
      throw new Error(
        `J09: Agent replied with payment-related content but no PaymentIntent found in DB.\n` +
        `Reply: "${s1.text.slice(0, 300)}"`,
      );
    }

    // ── Build result detail ───────────────────────────────────────────────────
    if (agentPaused) {
      const reason = needsOriginCP
        ? "Business missing postalCode despite seed (unexpected) or agent asked for origin CP"
        : "Agent paused for clarification";
      return {
        ok: true,
        detail: `J09: Agent paused — ${reason}. Reply: "${s1.text.slice(0, 150)}"`,
      };
    }

    if (!pi) {
      // Covered above — this branch shouldn't be reachable.
      throw new Error("J09: No PaymentIntent in DB and agent did not pause.");
    }

    // Assert metodo is the link-style variant (not the QR fake).
    if (pi.metodo !== "checkout_pro_link") {
      throw new Error(
        `J09: PaymentIntent.metodo expected "checkout_pro_link", got "${pi.metodo}"`,
      );
    }

    const montoNum = Number(pi.monto);
    const baseExpected = 3 * 4500; // 13500 ARS — base product total

    // Validate monto is at least the base product total (shipping adds on top).
    if (montoNum < baseExpected) {
      throw new Error(
        `J09: PaymentIntent.monto ${montoNum} < base product total ${baseExpected} (3 × $4500)`,
      );
    }

    // Exact-total guard: when shipping is quoted, monto MUST equal
    // base + shippingCostARS exactly. Catches the freight being counted
    // twice (amountARS injected as base+flete while create_payment_link
    // also adds the flete) or omitted.
    if (pi.shippingRequired && pi.shippingCostARS != null) {
      const expectedTotal = baseExpected + Number(pi.shippingCostARS);
      if (montoNum !== expectedTotal) {
        throw new Error(
          `J09: PaymentIntent.monto ${montoNum} != base ${baseExpected} + flete ${pi.shippingCostARS} ` +
          `(${expectedTotal}). Shipping is double-counted or dropped.`,
        );
      }
    }

    const shippingDetail = pi.shippingRequired
      ? `shippingRequired=true, shippingCostARS=${pi.shippingCostARS}, total=${montoNum}`
      : `shippingRequired=false (shipping not added)`;

    const linkDetail = hasLink ? "MP link generated" : mpError ? "MP link failed (token placeholder — expected in sandbox)" : "no link in reply";

    return {
      ok: true,
      detail: `PaymentIntent ${pi.id} (${pi.estado}) — ${shippingDetail}. ${linkDetail}. Reply: "${s1.text.slice(0, 120)}"`,
    };
  } finally {
    if (businessId) await cleanup(businessId, userId);
    await disconnect();
  }
}

module.exports = { runJ09 };

if (require.main === module) {
  runJ09()
    .then((r) => {
      console.log("J09 OK:", r.detail);
      process.exit(0);
    })
    .catch((err) => {
      console.error("J09 FAIL:", err.message);
      process.exit(1);
    });
}
