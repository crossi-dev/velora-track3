// Unit tests for synthesizeFromToolResult (companion-agent.synthesize.ts).
// Covers all four tool branches and validates that the register_sale success
// path produces a saleDraft that would survive extractSaleDraft's checks
// (productName a non-empty string, customerName present when supplied).

const assert = require("node:assert/strict");
const test = require("node:test");
const Module = require("node:module");
const path = require("node:path");

const SYNTHESIZE_PATH = path.resolve(
  __dirname,
  "../../src/lib/adk/companion-agent.synthesize.ts",
);

function loadSynthesize() {
  delete Module._cache[SYNTHESIZE_PATH];
  return require(SYNTHESIZE_PATH);
}

// ── register_sale success path ────────────────────────────────────────

test("synthesize register_sale success: saleDraft has non-empty productName", () => {
  const { synthesizeFromToolResult } = loadSynthesize();
  const result = synthesizeFromToolResult({
    name: "register_sale",
    response: {
      answer: "Te paso a confirmar la venta de Cubierta Firestone a Juan.",
      primaryAction: {
        type: "register_sale",
        matchedProductId: "prod-123",
        matchedCustomerId: "cust-456",
        quantity: 2,
        autoSend: false,
      },
      resolvedProductName: "Cubierta Firestone",
      resolvedCustomerName: "Juan García",
    },
  });
  const parsed = JSON.parse(result);
  assert.equal(parsed.intent, "register_sale");
  // Finding 1: productName must be a non-empty string, never null.
  const item = parsed.saleDraft.items[0];
  assert.equal(typeof item.productName, "string");
  assert.ok(item.productName.length > 0, "productName must not be empty");
  assert.equal(item.productName, "Cubierta Firestone");
  assert.equal(item.quantity, 2);
});

test("synthesize register_sale success: saleDraft has customerName when present", () => {
  const { synthesizeFromToolResult } = loadSynthesize();
  const result = synthesizeFromToolResult({
    name: "register_sale",
    response: {
      answer: "Confirmá la venta.",
      primaryAction: {
        type: "register_sale",
        matchedProductId: "prod-abc",
        matchedCustomerId: "cust-789",
        quantity: 1,
        autoSend: true,
      },
      resolvedProductName: "Aceite 10W40",
      resolvedCustomerName: "María López",
    },
  });
  const parsed = JSON.parse(result);
  // Finding 2: customerName must be set so sale-extractor does not default to
  // Consumidor Final when the companion actually named a customer.
  assert.equal(parsed.saleDraft.customerName, "María López");
});

test("synthesize register_sale success: no customerName → Consumidor Final path", () => {
  const { synthesizeFromToolResult } = loadSynthesize();
  const result = synthesizeFromToolResult({
    name: "register_sale",
    response: {
      answer: "Confirmá la venta.",
      primaryAction: {
        type: "register_sale",
        matchedProductId: "prod-abc",
        matchedCustomerId: null,
        quantity: 3,
        autoSend: false,
      },
      resolvedProductName: "Aceite 10W40",
      resolvedCustomerName: null,
    },
  });
  const parsed = JSON.parse(result);
  // When resolvedCustomerName is null, customerName must be absent from saleDraft
  // so sale-extractor correctly resolves to Consumidor Final.
  assert.ok(
    !("customerName" in parsed.saleDraft),
    "customerName must be absent when no customer resolved",
  );
  // productName must still be valid.
  assert.equal(parsed.saleDraft.items[0].productName, "Aceite 10W40");
});

test("synthesize register_sale success: top-level fields correct", () => {
  const { synthesizeFromToolResult } = loadSynthesize();
  const result = synthesizeFromToolResult({
    name: "register_sale",
    response: {
      answer: "Confirmación.",
      primaryAction: {
        type: "register_sale",
        matchedProductId: "prod-XYZ",
        matchedCustomerId: "cust-001",
        quantity: 5,
        autoSend: true,
      },
      resolvedProductName: "Filtro de Aire",
      resolvedCustomerName: "Carlos Pérez",
    },
  });
  const parsed = JSON.parse(result);
  assert.equal(parsed.matchedProductId, "prod-XYZ");
  assert.equal(parsed.matchedCustomerId, "cust-001");
  assert.equal(parsed.autoSend, true);
  assert.equal(parsed.confidence, 0.95);
});

// ── register_sale would survive extractSaleDraft ──────────────────────

test("synthesize register_sale: saleDraft items pass extractSaleDraft item check", () => {
  // extractSaleDraft skips items where productName is not a non-empty string.
  // This test asserts the synthesized item PASSES that gate.
  const { synthesizeFromToolResult } = loadSynthesize();
  const result = synthesizeFromToolResult({
    name: "register_sale",
    response: {
      answer: "Confirmá.",
      primaryAction: {
        type: "register_sale",
        matchedProductId: "p1",
        matchedCustomerId: null,
        quantity: 1,
        autoSend: false,
      },
      resolvedProductName: "Batería 12V",
      resolvedCustomerName: null,
    },
  });
  const parsed = JSON.parse(result);
  const item = parsed.saleDraft.items[0];
  // Mimic extractSaleDraft's gate condition exactly:
  //   const productName = typeof rawProductName === "string" ? rawProductName.trim() : ...
  //   if (!productName) continue;   ← this continue is what we must NOT hit
  const rawProductName = item.productName;
  const productName =
    typeof rawProductName === "string"
      ? rawProductName.trim()
      : String(rawProductName ?? "").trim();
  assert.ok(productName.length > 0, "productName must survive extractSaleDraft item gate");
});

// ── register_sale error path ──────────────────────────────────────────

test("synthesize register_sale error: intent is answer", () => {
  const { synthesizeFromToolResult } = loadSynthesize();
  const result = synthesizeFromToolResult({
    name: "register_sale",
    response: {
      error: "product_not_found",
      answer: 'No encontré "Widget" en el catálogo.',
    },
  });
  const parsed = JSON.parse(result);
  assert.equal(parsed.intent, "answer");
  assert.match(parsed.answer, /Widget/);
  assert.equal(parsed.confidence, 0.5);
});

// ── check_stock ───────────────────────────────────────────────────────

test("synthesize check_stock: intent is answer", () => {
  const { synthesizeFromToolResult } = loadSynthesize();
  const result = synthesizeFromToolResult({
    name: "check_stock",
    response: { answer: "Hay 3 unidades de Cubierta 185/70 R14." },
  });
  const parsed = JSON.parse(result);
  assert.equal(parsed.intent, "answer");
  assert.match(parsed.answer, /3 unidades/);
  assert.equal(parsed.confidence, 0.9);
});

test("synthesize check_stock: fallback answer when response is empty", () => {
  const { synthesizeFromToolResult } = loadSynthesize();
  const result = synthesizeFromToolResult({
    name: "check_stock",
    response: {},
  });
  const parsed = JSON.parse(result);
  assert.equal(parsed.intent, "answer");
  assert.ok(parsed.answer.length > 0);
});

// ── business_query ────────────────────────────────────────────────────

test("synthesize business_query: intent is business_query", () => {
  const { synthesizeFromToolResult } = loadSynthesize();
  const result = synthesizeFromToolResult({
    name: "business_query",
    response: { answer: "Las ventas del mes suman $15.000." },
  });
  const parsed = JSON.parse(result);
  assert.equal(parsed.intent, "business_query");
  assert.match(parsed.answer, /15\.000/);
  assert.equal(parsed.confidence, 0.9);
});

test("synthesize business_query: fallback answer when response.answer is empty", () => {
  const { synthesizeFromToolResult } = loadSynthesize();
  const result = synthesizeFromToolResult({
    name: "business_query",
    response: { answer: "" },
  });
  const parsed = JSON.parse(result);
  assert.equal(parsed.intent, "business_query");
  assert.ok(parsed.answer.length > 0, "fallback answer must not be empty");
});

// ── unknown tool ──────────────────────────────────────────────────────

test("synthesize unknown tool: intent is answer with fallback text", () => {
  const { synthesizeFromToolResult } = loadSynthesize();
  const result = synthesizeFromToolResult({
    name: "some_future_tool",
    response: { answer: "Resultado personalizado." },
  });
  const parsed = JSON.parse(result);
  assert.equal(parsed.intent, "answer");
  assert.equal(parsed.answer, "Resultado personalizado.");
});
