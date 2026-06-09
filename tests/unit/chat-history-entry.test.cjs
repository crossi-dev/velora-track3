const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildChatHistoryEntry,
  TRANSIENT_REPLY_PREFIX,
} = require("../../src/app/dashboard/lib/chat-history-entry.ts");

test("buildChatHistoryEntry limpia el prefijo transitorio pero mantiene la respuesta durable", () => {
  const entry = buildChatHistoryEntry({
    kind: "reply",
    text: `${TRANSIENT_REPLY_PREFIX}Necesito un dato más.`,
    timestamp: 123,
    createId: () => "reply-1",
  });

  assert.deepEqual(entry, {
    id: "reply-1",
    kind: "reply",
    text: "Necesito un dato más.",
    timestamp: 123,
  });
  assert.equal(entry.id.startsWith("tmp:"), false);
});

test("buildChatHistoryEntry no trata errores como temporales", () => {
  const entry = buildChatHistoryEntry({
    kind: "error",
    text: "No se pudo procesar la solicitud.",
    timestamp: 456,
    createId: () => "error-1",
  });

  assert.deepEqual(entry, {
    id: "error-1",
    kind: "error",
    text: "No se pudo procesar la solicitud.",
    timestamp: 456,
  });
  assert.equal(entry.id.startsWith("tmp:"), false);
});
