// Unit tests for SetupChecklist tier assignment (Task 1 — Stripe now/later tiers).
//
// Verifies that buildChecklistItems assigns "now" to catalog + whatsapp and
// "later" to mercadopago + andreani + afip, without breaking any existing
// field on ChecklistItem.

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildChecklistItems,
} = require("../../src/app/dashboard/components/SetupChecklist.helpers.ts");

// Minimal capability stubs — all false/missing to isolate tier logic.
const CAP_EMPTY = {
  whatsapp_business: false,
  whatsapp_phone: false,
  mercadopago: false,
  andreani: false,
  orca: false,
  arca: false,
};

const noOp = () => {};

// ── Tier presence ─────────────────────────────────────────────────────────────

test("buildChecklistItems: every item has a tier field", () => {
  const items = buildChecklistItems(CAP_EMPTY, false, noOp, noOp);
  for (const item of items) {
    assert.ok(
      item.tier === "now" || item.tier === "later",
      `item '${item.id}' must have tier "now" or "later", got '${item.tier}'`,
    );
  }
});

// ── currently_due items ("now") ───────────────────────────────────────────────

test("buildChecklistItems: stock has tier=now", () => {
  const items = buildChecklistItems(CAP_EMPTY, false, noOp, noOp);
  const stock = items.find((i) => i.id === "stock");
  assert.ok(stock, "stock item must exist");
  assert.equal(stock.tier, "now");
});

test("buildChecklistItems: whatsapp has tier=now", () => {
  const items = buildChecklistItems(CAP_EMPTY, false, noOp, noOp);
  const wa = items.find((i) => i.id === "whatsapp");
  assert.ok(wa, "whatsapp item must exist");
  assert.equal(wa.tier, "now");
});

// ── eventually_due items ("later") ────────────────────────────────────────────

test("buildChecklistItems: mercadopago has tier=later", () => {
  const items = buildChecklistItems(CAP_EMPTY, false, noOp, noOp);
  const mp = items.find((i) => i.id === "mercadopago");
  assert.ok(mp, "mercadopago item must exist");
  assert.equal(mp.tier, "later");
});

test("buildChecklistItems: andreani has tier=later", () => {
  const items = buildChecklistItems(CAP_EMPTY, false, noOp, noOp);
  const andreani = items.find((i) => i.id === "andreani");
  assert.ok(andreani, "andreani item must exist");
  assert.equal(andreani.tier, "later");
});

test("buildChecklistItems: afip has tier=later", () => {
  const items = buildChecklistItems(CAP_EMPTY, false, noOp, noOp);
  const afip = items.find((i) => i.id === "afip");
  assert.ok(afip, "afip item must exist");
  assert.equal(afip.tier, "later");
});

// ── now items lead in the returned array ─────────────────────────────────────

test("buildChecklistItems: all 'now' items appear before any 'later' item", () => {
  const items = buildChecklistItems(CAP_EMPTY, false, noOp, noOp);
  let seenLater = false;
  for (const item of items) {
    if (item.tier === "later") seenLater = true;
    if (seenLater && item.tier === "now") {
      assert.fail(`'now' item '${item.id}' appears after a 'later' item — now-items must lead`);
    }
  }
});

// ── Count guards (exactly 2 now, 3 later) ─────────────────────────────────────

test("buildChecklistItems: exactly 2 items are tier=now", () => {
  const items = buildChecklistItems(CAP_EMPTY, false, noOp, noOp);
  const nowCount = items.filter((i) => i.tier === "now").length;
  assert.equal(nowCount, 2, `expected 2 'now' items, got ${nowCount}`);
});

test("buildChecklistItems: exactly 3 items are tier=later", () => {
  const items = buildChecklistItems(CAP_EMPTY, false, noOp, noOp);
  const laterCount = items.filter((i) => i.tier === "later").length;
  assert.equal(laterCount, 3, `expected 3 'later' items, got ${laterCount}`);
});

// ── Existing fields preserved ─────────────────────────────────────────────────

test("buildChecklistItems: all items have required fields id/label/explain/done/actionLabel/onAction", () => {
  const items = buildChecklistItems(CAP_EMPTY, false, noOp, noOp);
  for (const item of items) {
    assert.ok(typeof item.id === "string" && item.id.length > 0, `item.id must be a non-empty string`);
    assert.ok(typeof item.label === "string" && item.label.length > 0, `item.label must be a non-empty string`);
    assert.ok(typeof item.explain === "string" && item.explain.length > 0, `item.explain must be a non-empty string`);
    assert.ok(typeof item.done === "boolean", `item.done must be boolean`);
    assert.ok(typeof item.actionLabel === "string", `item.actionLabel must be a string`);
    assert.ok(typeof item.onAction === "function", `item.onAction must be a function`);
  }
});

test("buildChecklistItems: done=true when hasProducts=true for stock item", () => {
  const items = buildChecklistItems(CAP_EMPTY, true, noOp, noOp);
  const stock = items.find((i) => i.id === "stock");
  assert.ok(stock);
  assert.equal(stock.done, true);
});

test("buildChecklistItems: done=false when hasProducts=false for stock item", () => {
  const items = buildChecklistItems(CAP_EMPTY, false, noOp, noOp);
  const stock = items.find((i) => i.id === "stock");
  assert.ok(stock);
  assert.equal(stock.done, false);
});
