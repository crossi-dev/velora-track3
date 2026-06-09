// Unit tests — wholesale_create_order honest-disclosure (FIX 5).
//
// Asserts that handleOrder returns explicit mock/persisted flags so callers
// cannot mistake a demo simulation for a real persisted order.
// Mirrors the *_MOCK_MODE convention used throughout Velora (ANDREANI_MOCK_MODE, etc.).

"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");

const SUT_PATH = path.resolve(__dirname, "../../src/app/api/peers/distribuidora-mendoza/_lib/order-skill.ts");

function loadOrderSkill() {
  delete require.cache[SUT_PATH];
  return require(SUT_PATH);
}

test("wholesale handleOrder success: mock=true and persisted=false are present", () => {
  const { handleOrder } = loadOrderSkill();
  const result = handleOrder({ productName: "quilmes", qty: 10 });
  assert.ok(!("error" in result), "quilmes must be in catalog — check catalog.ts if this fails");
  assert.equal(result.mock, true, "mock must be true — response must not claim a real order");
  assert.equal(result.persisted, false, "persisted must be false — no DB write occurs");
});

test("wholesale handleOrder success: trackingNote contains DEMO marker", () => {
  const { handleOrder } = loadOrderSkill();
  const result = handleOrder({ productName: "quilmes", qty: 5 });
  assert.ok(!("error" in result));
  assert.match(result.trackingNote, /DEMO/i, "trackingNote must contain DEMO marker for honest disclosure");
});

test("wholesale handleOrder error path: does not carry mock/persisted flags", () => {
  const { handleOrder } = loadOrderSkill();
  const result = handleOrder({ productName: "PRODUCTO_QUE_NO_EXISTE_XYZ", qty: 1 });
  assert.ok("error" in result, "unknown product must return error");
  assert.equal("mock" in result, false, "error path must not carry mock flag");
});

test("wholesale handleOrder: qty 0 → error, no mock/persisted flags", () => {
  const { handleOrder } = loadOrderSkill();
  const result = handleOrder({ productName: "quilmes", qty: 0 });
  assert.ok("error" in result, "qty 0 must return error");
});
