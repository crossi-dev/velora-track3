const assert = require("node:assert/strict");
const test = require("node:test");

const { buildAssistantCancellationMessage } = require("../../src/app/dashboard/lib/assistant-flow-chat.ts");

test("buildAssistantCancellationMessage devuelve el cierre de cancelación de confirmación", () => {
  assert.equal(
    buildAssistantCancellationMessage("confirmation"),
    "Done, no changes applied."
  );
});

test("buildAssistantCancellationMessage devuelve el cierre de descarte de stock", () => {
  assert.equal(
    buildAssistantCancellationMessage("stock_draft"),
    "Done, discarded that stock load."
  );
});
