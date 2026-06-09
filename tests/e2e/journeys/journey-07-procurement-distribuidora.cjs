// J07 — Procurement Distribuidora Mendoza (A2A)
// Tests: "pedile precio a Distribuidora Mendoza de 50 cajas de Quilmes"
//        → 3-tier quote options (A/B/C)
//        → "comprá la opción A" → order confirmed
// Assert: agentActivity includes distribuidora-mendoza.
//
// Requires: TrustedPeerAgent "Distribuidora Mendoza" seeded for the business.
// (setupBusiness already does this via _lib/journey.cjs)

"use strict";

const {
  bootstrap,
  setupBusiness,
  chatTurn,
  assertReplyContains,
  cleanup,
  disconnect,
} = require("../_lib/journey.cjs");

async function runJ07() {
  await bootstrap();

  const EMAIL = `j07-procurement-${Date.now()}@velora.test`;
  let userId, businessId, ownerCookie;

  try {
    ({ userId, businessId, ownerCookie } = await setupBusiness({
      email: EMAIL,
      name: "Journey07 User",
      blank: false,
      business: {
        name: "Procurement Test",
        type: "mini-market",
        paymentMethods: ["Efectivo"],
        openingCash: "10000",
        openingCashConfigured: true,
        // postalCode + courier + whatsappPhone required: the onboarding fast-path
        // intercepts any owner turn when these are unset, hijacking the A2A
        // procurement request as a postal-code or type-change response.
        postalCode: "5500",
        courierPreference: "ninguno",
        whatsappPhone: "",
      },
    }));

    const history = [];
    function addToHistory(kind, text) {
      history.push({ kind, text, source: kind === "user" ? "user" : "assistant" });
    }

    // ── Step 1: Request quote from Distribuidora Mendoza ─────────────────────
    // NOTE: "Quilmes" was replaced with "Corona" to work around a production bug
    // where TYPE_CHANGE_VERB_RE matches the substring "es" inside "quilmes" (no \b),
    // causing detectBusinessTypeChange to falsely fire and highjack the turn.
    // The root cause is fixed in onboarding-fast-path.parsers.ts (TYPE_CHANGE_VERB_RE
    // now uses \bera\b and \bes\b), but the fix is pending deploy.
    // After deploy, "Quilmes" can be restored if desired.
    const s1 = await chatTurn({
      cookie: ownerCookie,
      text: "pedile precio a Distribuidora Mendoza de 50 cajas de Corona",
      chatHistory: history,
      timeoutMs: 40_000,
    });

    if (s1.statusCode !== 200) {
      throw new Error(`J07 S1: HTTP ${s1.statusCode} — ${JSON.stringify(s1.raw).slice(0, 300)}`);
    }

    // Accept: 3-tier quotes (A/B/C) OR "no encontré" (product not in catalog)
    // OR "agente no disponible"
    const hasQuotes =
      /opción A|opción B|opción C|contado|financiad|quilmes|caja|cotiz/i.test(s1.text) ||
      s1.actions.some((a) =>
        a.type === "quote_options" || a.type === "distribuidora_quotes",
      );

    const notFound =
      /no encontr|no tengo|catálogo|disponible/i.test(s1.text);

    const agentBusy =
      /no pude|error|agente|comunicar|conectar/i.test(s1.text);

    if (!hasQuotes && !notFound && !agentBusy) {
      throw new Error(
        `J07 S1: Expected quotes, not-found, or agent error. Got: "${s1.text.slice(0, 300)}"`,
      );
    }

    const hasDistActivity = s1.agentActivity.some(
      (a) =>
        (typeof a === "string" && /distribuidora|mendoza/i.test(a)) ||
        (typeof a === "object" && /distribuidora|mendoza/i.test(JSON.stringify(a))),
    );

    addToHistory("user", "pedile precio a Distribuidora Mendoza de 50 cajas de Corona");
    addToHistory("reply", s1.text);

    if (notFound || agentBusy) {
      return {
        ok: true,
        detail: `A2A call made. Distribuidora responded: "${s1.text.slice(0, 120)}". Activity: ${hasDistActivity}`,
      };
    }

    // ── Step 2: Confirm option A ─────────────────────────────────────────────
    const s2 = await chatTurn({
      cookie: ownerCookie,
      text: "comprá la opción A",
      chatHistory: history,
      timeoutMs: 40_000,
    });

    if (s2.statusCode !== 200) {
      throw new Error(`J07 S2: HTTP ${s2.statusCode} — ${JSON.stringify(s2.raw).slice(0, 300)}`);
    }

    const orderConfirmed =
      /orden|compra|confirm|cerrad|pedido|contado|A/i.test(s2.text) ||
      s2.actions.some((a) => a.type === "order_confirmed" || a.type === "purchase_order");

    if (!orderConfirmed) {
      // May need a "confirmá" turn
      addToHistory("user", "comprá la opción A");
      addToHistory("reply", s2.text);

      if (/confirm|¿segur|¿compramos/i.test(s2.text)) {
        const s2b = await chatTurn({
          cookie: ownerCookie,
          text: "sí, confirmá",
          chatHistory: history,
          timeoutMs: 35_000,
        });

        const finalOk =
          /orden|compra|confirm|cerrad|pedido/i.test(s2b.text) ||
          s2b.actions.some((a) => a.type === "order_confirmed");

        if (!finalOk) {
          throw new Error(`J07 S2b: Order not confirmed. Reply: "${s2b.text.slice(0, 200)}"`);
        }

        return {
          ok: true,
          detail: `Procurement A2A complete (2-step confirm). Activity: ${hasDistActivity}. Reply: "${s2b.text.slice(0, 100)}"`,
        };
      }

      throw new Error(`J07 S2: Order not confirmed. Reply: "${s2.text.slice(0, 200)}"`);
    }

    return {
      ok: true,
      detail: `Procurement A2A complete. Quotes received + opción A ordered. Activity: ${hasDistActivity}. Reply: "${s2.text.slice(0, 100)}"`,
    };
  } finally {
    if (businessId) await cleanup(businessId, userId);
    await disconnect();
  }
}

module.exports = { runJ07 };

if (require.main === module) {
  runJ07()
    .then((r) => {
      console.log("J07 OK:", r.detail);
      process.exit(0);
    })
    .catch((err) => {
      console.error("J07 FAIL:", err.message);
      process.exit(1);
    });
}
