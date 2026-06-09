const assert = require("node:assert/strict");
const test = require("node:test");

const {
  DASHBOARD_DRAFT_VERSION,
  buildDashboardDraftSnapshot,
  hasDashboardDraftContent,
  parseDashboardDraftSnapshot,
} = require("../../src/app/dashboard/lib/dashboard-draft-persistence.ts");

test("buildDashboardDraftSnapshot conserva estados efímeros necesarios para retomar el chat", () => {
  const snapshot = buildDashboardDraftSnapshot({
    latestPurchaseRequest: null,
    assistantStockDraft: {
      supplierName: "Acme",
      items: [{ itemName: "Filtro", quantity: "3", unitPrice: "1500" }],
    },
    assistantConfirmationRequest: {
      id: "confirm-1",
      severity: "warning",
      title: "Confirmar ajuste",
      message: "¿Seguimos?",
      confirmLabel: "Sí",
      cancelLabel: "No",
      action: {
        type: "adjust_stock",
        product: { id: "prod-1", name: "Filtro" },
        mode: "increase",
        quantity: 3,
      },
    },
    assistantQuestionContext: "pregunta original",
    assistantInputHint: "Ej: Filtro Bosch",
  });

  assert.equal(snapshot.version, DASHBOARD_DRAFT_VERSION);
  assert.equal(snapshot.assistantStockDraft?.supplierName, "Acme");
  assert.equal(snapshot.assistantConfirmationRequest?.action.type, "adjust_stock");
  assert.equal(snapshot.assistantQuestionContext, "pregunta original");
  assert.equal(snapshot.assistantInputHint, "Ej: Filtro Bosch");
  assert.equal(hasDashboardDraftContent(snapshot), true);
});

test("parseDashboardDraftSnapshot ignora estructuras inválidas sin romper la hidratación", () => {
  // Snapshot with wrong/missing version is discarded entirely (version guard)
  const staleSnapshot = parseDashboardDraftSnapshot(JSON.stringify({
    assistantStockDraft: { supplierName: "Acme", items: [{ nope: true }] },
    assistantConfirmationRequest: { id: 1, action: "bad" },
    assistantQuestionContext: 123,
    assistantInputHint: null,
  }));
  assert.equal(staleSnapshot, null);

  // Snapshot with matching version but invalid fields returns nulled-out fields
  const currentSnapshot = parseDashboardDraftSnapshot(JSON.stringify({
    version: DASHBOARD_DRAFT_VERSION,
    assistantStockDraft: { supplierName: "Acme", items: [{ nope: true }] },
    assistantConfirmationRequest: { id: 1, action: "bad" },
    assistantQuestionContext: 123,
    assistantInputHint: null,
  }));

  assert.deepEqual(currentSnapshot, {
    version: DASHBOARD_DRAFT_VERSION,
    latestPurchaseRequest: null,
    assistantStockDraft: null,
    assistantConfirmationRequest: null,
    assistantQuestionContext: null,
    assistantInputHint: null,
  });
});
