// Tests para sale-extractor.ts (now async — uses matchProductByNameSemantic +
// findCustomersByDescription). Dependencies are mocked via Module._cache so
// no real DB / Vertex calls happen.

process.env.AUTH_SECRET = process.env.AUTH_SECRET || "test-sale-extractor-secret-32-bytes-x";
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://test:test@localhost:5432/test";

const assert = require("node:assert/strict");
const test = require("node:test");
const Module = require("node:module");
const path = require("node:path");

const SUT_PATH = path.resolve(
  __dirname,
  "../../src/app/api/business-assistant/_lib/intent-handlers/sale-extractor.ts",
);
const SEMANTIC_PATH = path.resolve(__dirname, "../../src/app/api/business-assistant/_lib/match-product-by-name.semantic.ts");
const VERTEX_SEARCH_PATH = path.resolve(__dirname, "../../src/lib/vertex-search.ts");
const SEMANTIC_RECALL_PATH = path.resolve(__dirname, "../../src/lib/semantic-recall.ts");

// Shared state for mock overrides
let _vertexEnabled = false;
let _vertexHits = [];
let _embeddingsEnabled = false;
let _semanticCustomerHits = null;

function installMocks() {
  // mock vertex-search (consumed by match-product-by-name.semantic.ts)
  Module._cache[VERTEX_SEARCH_PATH] = {
    id: VERTEX_SEARCH_PATH,
    filename: VERTEX_SEARCH_PATH,
    loaded: true,
    exports: {
      searchProductsSemantically: async () => _vertexHits,
      isVertexSearchEnabled: () => _vertexEnabled,
      indexProducts: async () => ({ ok: true, indexed: 0 }),
    },
  };

  // mock semantic-recall (findCustomersByDescription)
  Module._cache[SEMANTIC_RECALL_PATH] = {
    id: SEMANTIC_RECALL_PATH,
    filename: SEMANTIC_RECALL_PATH,
    loaded: true,
    exports: {
      findCustomersByDescription: async () => _semanticCustomerHits,
      persistCustomerEmbedding: async () => true,
      buildCustomerEmbedText: (c) => c.name,
    },
  };
}

function loadSut() {
  // Clear SUT and its non-mocked dependencies from cache on each load so
  // mock state is picked up fresh.
  delete Module._cache[SUT_PATH];
  delete Module._cache[SEMANTIC_PATH];
  installMocks();
  return require(SUT_PATH);
}

// Default: no Vertex, no embeddings (pure SQL fuzzy behavior)
const PRODUCTS = [
  { id: "p1", name: "Yerba Mate 1kg", sku: "YERBA-1KG", price: 6200 },
  { id: "p2", name: "Azucar 1kg", sku: "AZUCAR-1KG", price: 1800 },
  { id: "p3", name: "Cafe Molido 500g", sku: "CAFE-500G", price: 4900 },
  { id: "p4", name: "Arena Gruesa Premium", sku: null, price: 2500 },
];

const CUSTOMERS = [
  { id: "c1", name: "Carlos Pérez" },
  { id: "c2", name: "Carlos Gómez" },
  { id: "c3", name: "María López" },
  { id: "c4", name: "Juan" },
];

// ── Simple resolve ───────────────────────────────────────────────────

test("resolves simple sale: 'vendí 1 yerba mate a juan'", async () => {
  _vertexEnabled = false; _semanticCustomerHits = null;
  const { extractSaleDraft } = loadSut();
  const result = await extractSaleDraft(
    { customerName: "juan", items: [{ productName: "yerba mate", quantity: 1 }] },
    PRODUCTS,
    CUSTOMERS,
  );
  assert.equal(result.kind, "resolved");
  if (result.kind === "resolved") {
    assert.equal(result.customer.id, "c4");
    assert.equal(result.customer.name, "Juan");
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].productId, "p1");
    assert.equal(result.items[0].quantity, 1);
    assert.equal(result.items[0].unitPrice, 6200);
    assert.equal(result.items[0].subtotal, 6200);
    assert.equal(result.total, 6200);
  }
});

test("multi-item sale computes total", async () => {
  _vertexEnabled = false; _semanticCustomerHits = null;
  const { extractSaleDraft } = loadSut();
  const result = await extractSaleDraft(
    {
      customerName: "María López",
      items: [
        { productName: "yerba mate", quantity: 2 },
        { productName: "azucar", quantity: 3 },
      ],
    },
    PRODUCTS,
    CUSTOMERS,
  );
  assert.equal(result.kind, "resolved");
  if (result.kind === "resolved") {
    assert.equal(result.items.length, 2);
    assert.equal(result.total, 6200 * 2 + 1800 * 3);
  }
});

// ── Customer resolution ──────────────────────────────────────────────

test("ambiguous customer 'carlos' returns candidates", async () => {
  _vertexEnabled = false; _semanticCustomerHits = null;
  const { extractSaleDraft } = loadSut();
  const result = await extractSaleDraft(
    { customerName: "carlos", items: [{ productName: "yerba mate", quantity: 1 }] },
    PRODUCTS,
    CUSTOMERS,
  );
  assert.equal(result.kind, "ambiguous_customer");
  if (result.kind === "ambiguous_customer") {
    assert.equal(result.query, "carlos");
    assert.ok(result.candidates.length >= 2);
    const names = result.candidates.map((c) => c.name);
    assert.ok(names.includes("Carlos Pérez"));
    assert.ok(names.includes("Carlos Gómez"));
  }
});

test("empty/missing customer → Consumidor Final", async () => {
  _vertexEnabled = false; _semanticCustomerHits = null;
  const { extractSaleDraft } = loadSut();
  const result = await extractSaleDraft(
    { customerName: "", items: [{ productName: "yerba mate", quantity: 1 }] },
    PRODUCTS,
    CUSTOMERS,
  );
  assert.equal(result.kind, "resolved");
  if (result.kind === "resolved") {
    assert.equal(result.customer.id, null);
    assert.equal(result.customer.name, "Consumidor Final");
  }
});

test("'Consumidor Final' keyword resolves to Consumidor Final", async () => {
  _vertexEnabled = false; _semanticCustomerHits = null;
  const { extractSaleDraft } = loadSut();
  const result = await extractSaleDraft(
    { customerName: "Consumidor Final", items: [{ productName: "yerba mate", quantity: 1 }] },
    PRODUCTS,
    CUSTOMERS,
  );
  assert.equal(result.kind, "resolved");
  if (result.kind === "resolved") assert.equal(result.customer.id, null);
});

test("unknown customer name, no businessId → Consumidor Final (no semantic attempt)", async () => {
  _vertexEnabled = false; _semanticCustomerHits = null;
  const { extractSaleDraft } = loadSut();
  const result = await extractSaleDraft(
    { customerName: "Zacarías", items: [{ productName: "yerba mate", quantity: 1 }] },
    PRODUCTS,
    CUSTOMERS,
    undefined, // userText
    undefined, // businessId absent → no semantic call
  );
  assert.equal(result.kind, "resolved");
  if (result.kind === "resolved") {
    assert.equal(result.customer.id, null);
    assert.equal(result.customer.name, "Consumidor Final");
  }
});

// ── Fuzzy product match ──────────────────────────────────────────────

test("fuzzy product match: 'arena' → 'Arena Gruesa Premium'", async () => {
  _vertexEnabled = false; _semanticCustomerHits = null;
  const { extractSaleDraft } = loadSut();
  const result = await extractSaleDraft(
    { customerName: "juan", items: [{ productName: "arena", quantity: 1 }] },
    PRODUCTS,
    CUSTOMERS,
  );
  assert.equal(result.kind, "resolved");
  if (result.kind === "resolved") {
    assert.equal(result.items[0].productId, "p4");
  }
});

test("accent-insensitive product match: 'cafe' → 'Cafe Molido 500g'", async () => {
  _vertexEnabled = false; _semanticCustomerHits = null;
  const { extractSaleDraft } = loadSut();
  const result = await extractSaleDraft(
    { customerName: "juan", items: [{ productName: "café", quantity: 1 }] },
    PRODUCTS,
    CUSTOMERS,
  );
  assert.equal(result.kind, "resolved");
  if (result.kind === "resolved") assert.equal(result.items[0].productId, "p3");
});

test("unknown product is skipped, sale continues with others", async () => {
  _vertexEnabled = false; _semanticCustomerHits = null;
  const { extractSaleDraft } = loadSut();
  const result = await extractSaleDraft(
    {
      customerName: "juan",
      items: [
        { productName: "yerba mate", quantity: 2 },
        { productName: "producto-que-no-existe", quantity: 1 },
      ],
    },
    PRODUCTS,
    CUSTOMERS,
  );
  assert.equal(result.kind, "resolved");
  if (result.kind === "resolved") {
    assert.equal(result.items.length, 1);
    assert.deepEqual(result.skipped, ["producto-que-no-existe"]);
  }
});

// ── Price resolution ─────────────────────────────────────────────────

test("explicit unit price overrides catalog price", async () => {
  _vertexEnabled = false; _semanticCustomerHits = null;
  const { extractSaleDraft } = loadSut();
  const result = await extractSaleDraft(
    {
      customerName: "juan",
      items: [{ productName: "yerba mate", quantity: 1, unitPrice: 7000 }],
    },
    PRODUCTS,
    CUSTOMERS,
  );
  assert.equal(result.kind, "resolved");
  if (result.kind === "resolved") assert.equal(result.items[0].unitPrice, 7000);
});

test("missing catalog price → unitPrice null, subtotal null", async () => {
  _vertexEnabled = false; _semanticCustomerHits = null;
  const { extractSaleDraft } = loadSut();
  const result = await extractSaleDraft(
    { customerName: "juan", items: [{ productName: "yerba mate", quantity: 2 }] },
    [{ id: "p1", name: "Yerba Mate 1kg", sku: null, price: null }],
    CUSTOMERS,
  );
  assert.equal(result.kind, "resolved");
  if (result.kind === "resolved") {
    assert.equal(result.items[0].unitPrice, null);
    assert.equal(result.items[0].subtotal, null);
    assert.equal(result.total, 0);
  }
});

test("string unit price parses", async () => {
  _vertexEnabled = false; _semanticCustomerHits = null;
  const { extractSaleDraft } = loadSut();
  const result = await extractSaleDraft(
    {
      customerName: "juan",
      items: [{ productName: "yerba mate", quantity: 1, unitPrice: "500" }],
    },
    PRODUCTS,
    CUSTOMERS,
  );
  assert.equal(result.kind, "resolved");
  if (result.kind === "resolved") assert.equal(result.items[0].unitPrice, 500);
});

// ── Empty / edge cases ───────────────────────────────────────────────

test("null draft → empty", async () => {
  _vertexEnabled = false; _semanticCustomerHits = null;
  const { extractSaleDraft } = loadSut();
  const result = await extractSaleDraft(null, PRODUCTS, CUSTOMERS);
  assert.equal(result.kind, "empty");
  if (result.kind === "empty") assert.equal(result.reason, "no_draft");
});

test("empty items → empty", async () => {
  _vertexEnabled = false; _semanticCustomerHits = null;
  const { extractSaleDraft } = loadSut();
  const result = await extractSaleDraft({ customerName: "juan", items: [] }, PRODUCTS, CUSTOMERS);
  assert.equal(result.kind, "empty");
});

test("all items skipped (unknown product) → empty", async () => {
  _vertexEnabled = false; _semanticCustomerHits = null;
  const { extractSaleDraft } = loadSut();
  const result = await extractSaleDraft(
    { customerName: "juan", items: [{ productName: "xyz123", quantity: 1 }] },
    PRODUCTS,
    CUSTOMERS,
  );
  assert.equal(result.kind, "empty");
  if (result.kind === "empty") assert.equal(result.reason, "no_items_resolved");
});

// ── Non-string defense (Bug B regression: TypeError e.trim is not a function) ──

test("non-string productName (number) is coerced, not thrown", async () => {
  _vertexEnabled = false; _semanticCustomerHits = null;
  const { extractSaleDraft } = loadSut();
  const result = await extractSaleDraft(
    { customerName: "juan", items: [{ productName: 123, quantity: 1 }] },
    PRODUCTS,
    CUSTOMERS,
  );
  assert.equal(result.kind, "empty"); // "123" doesn't match catalog → skipped → no resolved items
});

test("non-string customerName (object) is coerced, not thrown", async () => {
  _vertexEnabled = false; _semanticCustomerHits = null;
  const { extractSaleDraft } = loadSut();
  const result = await extractSaleDraft(
    { customerName: { wat: "no" }, items: [{ productName: "yerba mate", quantity: 1 }] },
    PRODUCTS,
    CUSTOMERS,
  );
  // Should not throw; falls back to Consumidor Final or raw customer.
  assert.ok(result.kind === "resolved" || result.kind === "ambiguous_customer");
});

test("non-string quantity (boolean) coerces via toNumber without throwing", async () => {
  _vertexEnabled = false; _semanticCustomerHits = null;
  const { extractSaleDraft } = loadSut();
  const result = await extractSaleDraft(
    { customerName: "juan", items: [{ productName: "yerba mate", quantity: true }] },
    PRODUCTS,
    CUSTOMERS,
  );
  // true → toString → "true" → parseFloat NaN → null → quantity <= 0 → skipped
  assert.equal(result.kind, "empty");
});

test("non-string unitPrice (array) coerces without throwing", async () => {
  _vertexEnabled = false; _semanticCustomerHits = null;
  const { extractSaleDraft } = loadSut();
  const result = await extractSaleDraft(
    { customerName: "juan", items: [{ productName: "yerba mate", quantity: 1, unitPrice: [500] }] },
    PRODUCTS,
    CUSTOMERS,
  );
  // [500] → String → "500" → parses as 500 (arrays stringify their single element).
  // Important: must not throw, regardless of the coerced value.
  assert.ok(result.kind === "resolved" || result.kind === "empty");
});

test("zero quantity is skipped", async () => {
  _vertexEnabled = false; _semanticCustomerHits = null;
  const { extractSaleDraft } = loadSut();
  const result = await extractSaleDraft(
    {
      customerName: "juan",
      items: [
        { productName: "yerba mate", quantity: 0 },
        { productName: "azucar", quantity: 1 },
      ],
    },
    PRODUCTS,
    CUSTOMERS,
  );
  assert.equal(result.kind, "resolved");
  if (result.kind === "resolved") {
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].productId, "p2");
  }
});

// ── Semantic fallback paths ──────────────────────────────────────────

test("deterministic fast path: SQL fuzzy hits → Vertex NOT called", async () => {
  // Proof that deterministic path runs first and Vertex is never called when
  // the SQL matcher already finds the product.
  let vertexCalled = false;
  delete Module._cache[VERTEX_SEARCH_PATH];
  Module._cache[VERTEX_SEARCH_PATH] = {
    id: VERTEX_SEARCH_PATH,
    filename: VERTEX_SEARCH_PATH,
    loaded: true,
    exports: {
      searchProductsSemantically: async () => { vertexCalled = true; return []; },
      isVertexSearchEnabled: () => true, // enabled but should NOT be called on a SQL hit
    },
  };
  delete Module._cache[SUT_PATH];
  delete Module._cache[SEMANTIC_PATH];
  const { extractSaleDraft } = require(SUT_PATH);

  const result = await extractSaleDraft(
    { customerName: "juan", items: [{ productName: "yerba mate", quantity: 1 }] },
    PRODUCTS,
    CUSTOMERS,
    undefined,
    "biz_test",
  );
  assert.equal(result.kind, "resolved");
  assert.equal(vertexCalled, false, "Vertex must NOT be called when SQL fuzzy already matched");
});

test("semantic product fallback: SQL miss + Vertex hit → product resolved", async () => {
  // SQL miss ("destornillador" not in catalog), Vertex returns a hit.
  delete Module._cache[VERTEX_SEARCH_PATH];
  Module._cache[VERTEX_SEARCH_PATH] = {
    id: VERTEX_SEARCH_PATH,
    filename: VERTEX_SEARCH_PATH,
    loaded: true,
    exports: {
      searchProductsSemantically: async () => [{ id: "p1", name: "Yerba Mate 1kg", score: 0.85 }],
      isVertexSearchEnabled: () => true,
    },
  };
  delete Module._cache[SUT_PATH];
  delete Module._cache[SEMANTIC_PATH];
  const { extractSaleDraft } = require(SUT_PATH);

  const result = await extractSaleDraft(
    { customerName: "juan", items: [{ productName: "hierba mate importada", quantity: 1 }] },
    PRODUCTS,
    CUSTOMERS,
    undefined,
    "biz_test",
  );
  assert.equal(result.kind, "resolved");
  if (result.kind === "resolved") assert.equal(result.items[0].productId, "p1");
});

test("semantic product fallback: Vertex error degrades gracefully (product skipped)", async () => {
  delete Module._cache[VERTEX_SEARCH_PATH];
  Module._cache[VERTEX_SEARCH_PATH] = {
    id: VERTEX_SEARCH_PATH,
    filename: VERTEX_SEARCH_PATH,
    loaded: true,
    exports: {
      searchProductsSemantically: async () => { throw new Error("vertex down"); },
      isVertexSearchEnabled: () => true,
    },
  };
  delete Module._cache[SUT_PATH];
  delete Module._cache[SEMANTIC_PATH];
  const { extractSaleDraft } = require(SUT_PATH);

  const result = await extractSaleDraft(
    { customerName: "juan", items: [{ productName: "xyz-no-match", quantity: 1 }] },
    PRODUCTS,
    CUSTOMERS,
    undefined,
    "biz_test",
  );
  // Vertex failure → product skipped → empty (does not throw)
  assert.equal(result.kind, "empty");
});

test("semantic customer fallback: SQL miss + semantic hit ≥0.75 → customer resolved", async () => {
  _vertexEnabled = false;
  _semanticCustomerHits = [{ id: "c3", name: "María López", similarity: 0.82 }];
  const { extractSaleDraft } = loadSut();

  const result = await extractSaleDraft(
    { customerName: "la chica de las plantas", items: [{ productName: "yerba mate", quantity: 1 }] },
    PRODUCTS,
    CUSTOMERS,
    undefined,
    "biz_test",
  );
  assert.equal(result.kind, "resolved");
  if (result.kind === "resolved") {
    assert.equal(result.customer.id, "c3");
    assert.equal(result.customer.name, "María López");
  }
});

test("semantic customer fallback: similarity < 0.75 → Consumidor Final", async () => {
  _vertexEnabled = false;
  _semanticCustomerHits = [{ id: "c3", name: "María López", similarity: 0.6 }];
  const { extractSaleDraft } = loadSut();

  const result = await extractSaleDraft(
    { customerName: "persona desconocida", items: [{ productName: "yerba mate", quantity: 1 }] },
    PRODUCTS,
    CUSTOMERS,
    undefined,
    "biz_test",
  );
  assert.equal(result.kind, "resolved");
  if (result.kind === "resolved") {
    assert.equal(result.customer.id, null);
    assert.equal(result.customer.name, "Consumidor Final");
  }
});

test("semantic customer fallback: no businessId → Consumidor Final (no embedding call)", async () => {
  // Verify no semantic call is made when businessId is absent
  let semanticCalled = false;
  delete Module._cache[SEMANTIC_RECALL_PATH];
  Module._cache[SEMANTIC_RECALL_PATH] = {
    id: SEMANTIC_RECALL_PATH,
    filename: SEMANTIC_RECALL_PATH,
    loaded: true,
    exports: {
      findCustomersByDescription: async () => { semanticCalled = true; return null; },
      persistCustomerEmbedding: async () => true,
      buildCustomerEmbedText: (c) => c.name,
    },
  };
  delete Module._cache[SUT_PATH];
  delete Module._cache[SEMANTIC_PATH];
  delete Module._cache[VERTEX_SEARCH_PATH];
  Module._cache[VERTEX_SEARCH_PATH] = {
    id: VERTEX_SEARCH_PATH,
    filename: VERTEX_SEARCH_PATH,
    loaded: true,
    exports: {
      searchProductsSemantically: async () => [],
      isVertexSearchEnabled: () => false,
    },
  };
  const { extractSaleDraft } = require(SUT_PATH);

  const result = await extractSaleDraft(
    { customerName: "nombre desconocido", items: [{ productName: "yerba mate", quantity: 1 }] },
    PRODUCTS,
    CUSTOMERS,
    undefined,
    undefined, // no businessId
  );
  assert.equal(result.kind, "resolved");
  if (result.kind === "resolved") assert.equal(result.customer.name, "Consumidor Final");
  assert.equal(semanticCalled, false, "semantic customer search must NOT fire without businessId");
});

test("semantic customer fallback: embedding error degrades gracefully → Consumidor Final", async () => {
  _vertexEnabled = false;
  _semanticCustomerHits = null; // findCustomersByDescription mocked to return null (error case)
  const { extractSaleDraft } = loadSut();

  const result = await extractSaleDraft(
    { customerName: "cliente raro", items: [{ productName: "yerba mate", quantity: 1 }] },
    PRODUCTS,
    CUSTOMERS,
    undefined,
    "biz_test",
  );
  assert.equal(result.kind, "resolved");
  if (result.kind === "resolved") {
    assert.equal(result.customer.id, null);
    assert.equal(result.customer.name, "Consumidor Final");
  }
});
