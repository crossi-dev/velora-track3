/**
 * supervisor-parser.test.cjs
 *
 * Cubre modos de fallo de shape drift que aparecen en outputs LLM:
 *   1. Caracteres Unicode invisibles (ZWNJ, ZWSP, BOM) que rompen JSON.parse
 *   2. kind = null cuando hay clarification/answer/actions/notification
 *   3. kind = { type: "answer" } / { reply: "answer" } / [...] en vez de string
 *   4. Combo: invisibles + shape drift
 *   5. Multi-block: stub seguido de bloque markdown-fenced con contenido real
 */

"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { safeParseJson } = require(
  "../../src/app/api/supervisor/_lib/supervisor-parser.ts",
);

test("safeParseJson: clean answer passes through", () => {
  const out = safeParseJson('{"kind":"answer","answer":"hola"}');
  assert.equal(out?.kind, "answer");
  assert.equal(out?.answer, "hola");
});

test("safeParseJson: strips ZWNJ before kind value", () => {
  // Replicates: {"kind":‌"answer", ...}  with U+200C between : and "
  const raw = '{"kind":\u200C"answer","answer":"hi"}';
  const out = safeParseJson(raw);
  assert.equal(out?.kind, "answer");
  assert.equal(out?.answer, "hi");
});

test("safeParseJson: strips ZWSP between fields", () => {
  const raw = '{"kind":\u200B "answer", "answer": "x"}';
  const out = safeParseJson(raw);
  assert.equal(out?.kind, "answer");
});

test("safeParseJson: strips multiple invisible chars + BOM", () => {
  const raw = '\uFEFF{"kind":\u200C"answer",\u2060"answer":"y"}';
  const out = safeParseJson(raw);
  assert.equal(out?.kind, "answer");
  assert.equal(out?.answer, "y");
});

test("safeParseJson: infers kind=clarification when only clarification populated", () => {
  const raw = '{"kind":null,"answer":null,"actions":null,"clarification":{"question":"¿precio?","context":"actual $100"},"notification":null}';
  const out = safeParseJson(raw);
  assert.equal(out?.kind, "clarification");
  assert.equal(out?.clarification?.question, "¿precio?");
});

test("safeParseJson: infers kind=answer when only answer populated and kind missing", () => {
  const raw = '{"answer":"Tenés 5 unidades","actions":null}';
  const out = safeParseJson(raw);
  assert.equal(out?.kind, "answer");
  assert.equal(out?.answer, "Tenés 5 unidades");
});

test("safeParseJson: unwraps kind={type:'answer'} to 'answer'", () => {
  const raw = '{"kind":{"type":"answer"},"answer":"$100","actions":null}';
  const out = safeParseJson(raw);
  assert.equal(out?.kind, "answer");
  assert.equal(out?.answer, "$100");
});

test("safeParseJson: combo invisible + null kind + clarification", () => {
  const raw = '{"kind":\u200Cnull,"clarification":{"question":"q","context":"c"}}';
  const out = safeParseJson(raw);
  assert.equal(out?.kind, "clarification");
});

test("safeParseJson: returns null when truly irrecoverable", () => {
  // Malformed JSON, no recovery possible
  assert.equal(safeParseJson("not json at all"), null);
  assert.equal(safeParseJson(""), null);
  assert.equal(safeParseJson("   "), null);
});

test("safeParseJson: returns null when kind and all body fields empty", () => {
  const raw = '{"kind":null,"answer":null,"actions":null,"clarification":null,"notification":null}';
  const out = safeParseJson(raw);
  assert.equal(out, null);
});

test("safeParseJson: invisible char inside string literal is preserved", () => {
  // Sanitization is global — invisible chars in user-facing strings get
  // dropped too. That's acceptable: they were noise from the model anyway.
  const raw = '{"kind":"answer","answer":"hola\u200Bmundo"}';
  const out = safeParseJson(raw);
  assert.equal(out?.kind, "answer");
  assert.equal(out?.answer, "holamundo");
});

// ─── Shape drift recovery (vendor-agnostic) ───

test("safeParseJson: prefers second JSON block when first is a {kind:null} stub", () => {
  const raw = '{"kind":null}\n\n```json\n{"kind":"answer","answer":"Tenés 2 productos"}\n```';
  const out = safeParseJson(raw);
  assert.equal(out?.kind, "answer");
  assert.equal(out?.answer, "Tenés 2 productos");
});

test("safeParseJson: hoists answer string from kind object", () => {
  const raw = '{"kind":{"answer":"El inventario actual tiene 2 productos"},"actions":null,"clarification":null,"notification":null}';
  const out = safeParseJson(raw);
  assert.equal(out?.kind, "answer");
  assert.equal(out?.answer, "El inventario actual tiene 2 productos");
});

test("safeParseJson: wraps action-shaped kind into actions array", () => {
  // data.name (not productName) matches deleteProductDataSchema { name: string }
  const raw = '{"kind":{"intent":"delete_product","data":{"name":"destornillador"},"summary":"Borrar"}}';
  const out = safeParseJson(raw);
  assert.equal(out?.kind, "actions");
  assert.equal(out?.actions?.[0]?.intent, "delete_product");
});

test("safeParseJson: unwraps array-form kind", () => {
  const raw = '{"kind":["clarification"],"clarification":{"question":"q","context":"c"}}';
  const out = safeParseJson(raw);
  assert.equal(out?.kind, "clarification");
});

test("safeParseJson: unwraps kind={reply:'answer'} variant", () => {
  const raw = '{"kind":{"reply":"answer","query":"precio destornillador"}}\n```json\n{"kind":"answer","answer":"$100"}\n```';
  const out = safeParseJson(raw);
  assert.equal(out?.kind, "answer");
});

// ─── Double-wrap recovery (Gemini 2026-05-25 prod incident) ───────────────
// Gemini returns syntactically valid outer JSON whose `answer` field is itself
// a markdown-fenced JSON string. The outer parse succeeds but answer = fence.

test("safeParseJson: recovers when answer field contains ```json fenced inner JSON", () => {
  // Exact shape of the production incident
  const inner = JSON.stringify({ kind: "answer", answer: "Buen día, ¿en qué te puedo ayudar?" });
  const fenced = "```json\n" + inner + "\n```";
  const outer = JSON.stringify({ answer: fenced, actions: [], chips: null });
  const out = safeParseJson(outer);
  assert.equal(out?.kind, "answer");
  assert.equal(out?.answer, "Buen día, ¿en qué te puedo ayudar?");
});

test("safeParseJson: recovers when answer field contains ``` (no lang) fenced inner JSON", () => {
  const inner = JSON.stringify({ kind: "answer", answer: "Hola!" });
  const fenced = "```\n" + inner + "\n```";
  const outer = JSON.stringify({ answer: fenced, actions: [] });
  const out = safeParseJson(outer);
  assert.equal(out?.kind, "answer");
  assert.equal(out?.answer, "Hola!");
});

test("safeParseJson: recovers when answer field contains ```JSON (uppercase) fenced inner JSON", () => {
  const inner = JSON.stringify({ kind: "answer", answer: "Stock OK" });
  const fenced = "```JSON\n" + inner + "\n```";
  const outer = JSON.stringify({ answer: fenced, actions: null });
  const out = safeParseJson(outer);
  assert.equal(out?.kind, "answer");
  assert.equal(out?.answer, "Stock OK");
});

test("safeParseJson: answer field with plain text (not a fence) is NOT unwrapped", () => {
  const out = safeParseJson('{"kind":"answer","answer":"Tenés 5 unidades en stock"}');
  assert.equal(out?.kind, "answer");
  assert.equal(out?.answer, "Tenés 5 unidades en stock");
});

test("safeParseJson: fenced inner JSON with actions kind is recovered correctly", () => {
  const inner = JSON.stringify({
    kind: "actions",
    actions: [{ intent: "business_query", data: { query: "stock tornillo" }, summary: "Ver stock de tornillo" }],
    answer: "",
  });
  const fenced = "```json\n" + inner + "\n```";
  const outer = JSON.stringify({ answer: fenced, actions: [] });
  const out = safeParseJson(outer);
  assert.equal(out?.kind, "actions");
  assert.equal(out?.actions?.[0]?.intent, "business_query");
});

// ─── Fast-path double-wrap recovery (ADK 2026-05-27 prod bug) ────────────────
// Gemini on the ADK path (no outputSchema) returns a valid outer JSON with
// kind present but answer = markdown-fenced inner JSON. The fast path exits
// early WITHOUT running the legacy double-wrap recovery — the fence leaks
// through as the chat answer. Fix: double-wrap check added to fast path.

test("safeParseJson: fast path recovers when outer JSON has kind field AND answer contains ```json fence", () => {
  // This is the ADK double-wrap variant: outer JSON includes `kind` so the
  // fast path fires (trimmedRaw.startsWith("{") + kind is valid). Before the
  // fix the fast path returned the fenced string as the answer.
  const inner = JSON.stringify({ kind: "answer", answer: "Entendido. Quedo a la espera de tus instrucciones." });
  const fenced = "```json\n" + inner + "\n```";
  const outer = JSON.stringify({ kind: "answer", answer: fenced, actions: null });
  const out = safeParseJson(outer);
  assert.equal(out?.kind, "answer");
  assert.equal(out?.answer, "Entendido. Quedo a la espera de tus instrucciones.");
});

test("safeParseJson: fast path recovers when outer JSON has kind field AND answer is bare JSON string", () => {
  const inner = JSON.stringify({ kind: "answer", answer: "Perfecto, anotado." });
  const outer = JSON.stringify({ kind: "answer", answer: inner, actions: null });
  const out = safeParseJson(outer);
  assert.equal(out?.kind, "answer");
  assert.equal(out?.answer, "Perfecto, anotado.");
});

test("safeParseJson: fast path does NOT unwrap plain-text answers (no fence, no bare JSON)", () => {
  const out = safeParseJson('{"kind":"answer","answer":"Tenés 3 productos en stock","actions":null}');
  assert.equal(out?.kind, "answer");
  assert.equal(out?.answer, "Tenés 3 productos en stock");
});

// ─── ADK "answer-buried-in-actions" recovery (2026-05-27 shape drift) ────────
// ADK InMemoryRunner cannot forward responseSchema — occasionally emits
// kind=null with the reply text buried in actions[].data.text / .message / .answer.

test("safeParseJson: recovers ADK reply from actions[0].data.text (real ADK shape)", () => {
  const raw = JSON.stringify({
    actions: [{ type: "reply", data: { text: "Hola Carlos, ¿en qué te ayudo?" } }],
    kind: null,
  });
  const out = safeParseJson(raw);
  assert.equal(out?.kind, "answer");
  assert.equal(out?.answer, "Hola Carlos, ¿en qué te ayudo?");
});

test("safeParseJson: recovers ADK reply from actions[0].data as bare string", () => {
  const raw = JSON.stringify({ actions: [{ data: "hi" }] });
  const out = safeParseJson(raw);
  assert.equal(out?.kind, "answer");
  assert.equal(out?.answer, "hi");
});

test("safeParseJson: recovers ADK reply from actions[0].data.message", () => {
  const raw = JSON.stringify({ actions: [{ data: { message: "hi" } }] });
  const out = safeParseJson(raw);
  assert.equal(out?.kind, "answer");
  assert.equal(out?.answer, "hi");
});

test("safeParseJson: recovers ADK reply from actions[0].data.answer", () => {
  const raw = JSON.stringify({ actions: [{ data: { answer: "hi" } }] });
  const out = safeParseJson(raw);
  assert.equal(out?.kind, "answer");
  assert.equal(out?.answer, "hi");
});

test("safeParseJson: no recovery when actions array is empty", () => {
  const raw = JSON.stringify({ actions: [], kind: null });
  const out = safeParseJson(raw);
  assert.equal(out, null);
});

test("safeParseJson: no recovery when top-level answer is already populated", () => {
  const raw = JSON.stringify({ kind: "answer", answer: "already here", actions: [] });
  const out = safeParseJson(raw);
  assert.equal(out?.kind, "answer");
  assert.equal(out?.answer, "already here");
});
