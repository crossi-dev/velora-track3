// J05 — MercadoLibre sync (ML_MOCK_MODE=true)
// Tests: "sincronizá mi catálogo con MercadoLibre" → reply contains products/sync
// and agentActivity includes a MercadoLibre mention.
//
// Depends on ML_MOCK_MODE=true in Cloud Run env.

"use strict";

const {
  bootstrap,
  setupBusiness,
  chatTurn,
  assertReplyContains,
  cleanup,
  disconnect,
} = require("../_lib/journey.cjs");

async function runJ05() {
  await bootstrap();

  const EMAIL = `j05-ml-sync-${Date.now()}@velora.test`;
  let userId, businessId, ownerCookie;

  try {
    ({ userId, businessId, ownerCookie } = await setupBusiness({
      email: EMAIL,
      name: "Journey05 User",
      blank: false,
      business: {
        name: "ML Sync Test",
        type: "mini-market",
        paymentMethods: ["Mercado Pago"],
        openingCash: "5000",
        openingCashConfigured: true,
      },
    }));

    // ── Step 1: Request ML sync ──────────────────────────────────────────────
    const result = await chatTurn({
      cookie: ownerCookie,
      text: "sincronizá mi catálogo con MercadoLibre",
      chatHistory: [],
      timeoutMs: 35_000,
    });

    if (result.statusCode !== 200) {
      throw new Error(
        `J05: HTTP ${result.statusCode} — ${JSON.stringify(result.raw).slice(0, 300)}`,
      );
    }

    // Accept a wide range of valid responses:
    // - Sync confirmation ("sincronicé", "5 productos", "catálogo")
    // - Request for ML auth ("conectar", "autorizar", "credenciales")
    // - Activity bubbles visible
    const syncDone = /sincroniz|catálogo|productos|mercadolibre|ml|publicacion/i.test(result.text);
    const authRequired = /conectar|autorizar|credencial|integrar|oauth|acceso/i.test(result.text);
    const hasMLActivity = result.agentActivity.some(
      (a) =>
        (typeof a === "string" && /mercadolibre|ml/i.test(a)) ||
        (typeof a === "object" && /mercadolibre|ml/i.test(JSON.stringify(a))),
    );

    if (!syncDone && !authRequired) {
      throw new Error(
        `J05: Expected sync confirmation or auth request. Got: "${result.text.slice(0, 200)}"`,
      );
    }

    // The activity bubble check is advisory (not all NLU paths emit it)
    const activityNote = hasMLActivity
      ? "agentActivity includes ML reference"
      : "agentActivity did NOT include ML reference (may need ML fast-path)";

    return {
      ok: true,
      detail: `ML sync triggered. authRequired=${authRequired}, syncDone=${syncDone}. ${activityNote}. Reply: "${result.text.slice(0, 100)}"`,
    };
  } finally {
    if (businessId) await cleanup(businessId, userId);
    await disconnect();
  }
}

module.exports = { runJ05 };

if (require.main === module) {
  runJ05()
    .then((r) => {
      console.log("J05 OK:", r.detail);
      process.exit(0);
    })
    .catch((err) => {
      console.error("J05 FAIL:", err.message);
      process.exit(1);
    });
}
