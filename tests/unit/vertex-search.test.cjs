// Vertex AI Search grounding — unit tests del client + del fallback semántico
// en match-product-by-name. Cierra gap "Grounding weak" del Track 3 audit.
//
// No tocamos red real — mockeamos `fetch` global para verificar el shape de
// la request y la deserialización del response.

process.env.AUTH_SECRET = process.env.AUTH_SECRET || "test-vertex-search-secret-32-bytes-long-x";
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://test:test@localhost:5432/test";

const assert = require("node:assert/strict");
const test = require("node:test");

// Stub google-auth-library before requiring the lib under test.
const Module = require("module");
const origResolve = Module._resolveFilename;
const origLoad = Module._load;
const stubAuth = {
  GoogleAuth: class {
    async getClient() {
      return { async getAccessToken() { return { token: "test-token" }; } };
    }
  },
};
Module._load = function (request, parent, ...rest) {
  if (request === "google-auth-library") return stubAuth;
  return origLoad.call(this, request, parent, ...rest);
};

const {
  searchProductsSemantically,
  indexProducts,
  isVertexSearchEnabled,
  _datastoreIdForTesting,
} = require("../../src/lib/vertex-search.ts");

// Restore module loader for any subsequent test files
process.on("exit", () => {
  Module._load = origLoad;
  Module._resolveFilename = origResolve;
});

// ── isVertexSearchEnabled ─────────────────────────────────────────────────

test("isVertexSearchEnabled: false por defecto", () => {
  delete process.env.USE_VERTEX_SEARCH;
  assert.equal(isVertexSearchEnabled(), false);
});

test("isVertexSearchEnabled: true cuando flag explicit", () => {
  process.env.USE_VERTEX_SEARCH = "true";
  assert.equal(isVertexSearchEnabled(), true);
  delete process.env.USE_VERTEX_SEARCH;
});

test("isVertexSearchEnabled: 'false' string no activa", () => {
  process.env.USE_VERTEX_SEARCH = "false";
  assert.equal(isVertexSearchEnabled(), false);
  delete process.env.USE_VERTEX_SEARCH;
});

// ── datastoreId namespacing ───────────────────────────────────────────────

test("datastoreId: prefix + sanitización de chars no permitidos", () => {
  const id = _datastoreIdForTesting("biz_ABC123-xyz!");
  assert.match(id, /^velora-products-/);
  assert.doesNotMatch(id, /[A-Z!_]/);
});

test("datastoreId: trunca defensivamente bajo 63 chars", () => {
  const id = _datastoreIdForTesting("a".repeat(100));
  assert.ok(id.length <= 63);
});

// ── searchProductsSemantically: short-circuits ──────────────────────────────

test("searchProductsSemantically: null cuando flag disabled", async () => {
  delete process.env.USE_VERTEX_SEARCH;
  const out = await searchProductsSemantically({ businessId: "b1", query: "destornillador" });
  assert.equal(out, null);
});

test("searchProductsSemantically: null si query muy corto", async () => {
  process.env.USE_VERTEX_SEARCH = "true";
  const out = await searchProductsSemantically({ businessId: "b1", query: "a" });
  assert.equal(out, null);
  delete process.env.USE_VERTEX_SEARCH;
});

test("searchProductsSemantically: null si businessId falta", async () => {
  process.env.USE_VERTEX_SEARCH = "true";
  const out = await searchProductsSemantically({ businessId: "", query: "destornillador" });
  assert.equal(out, null);
  delete process.env.USE_VERTEX_SEARCH;
});

// ── searchProductsSemantically: happy path con fetch mock ───────────────────

test("searchProductsSemantically: parsea response y ordena por score desc", async () => {
  process.env.USE_VERTEX_SEARCH = "true";
  const origFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    async json() {
      return {
        results: [
          { document: { structData: { id: "p2", name: "Desarmador Phillips" } }, modelScore: { value: 0.85 } },
          { document: { structData: { id: "p1", name: "Atornillador" } }, modelScore: { value: 0.92 } },
        ],
      };
    },
  });
  const hits = await searchProductsSemantically({ businessId: "biz1", query: "destornillador" });
  assert.ok(Array.isArray(hits));
  assert.equal(hits.length, 2);
  assert.equal(hits[0].id, "p1"); // higher score first
  assert.equal(hits[0].score, 0.92);
  global.fetch = origFetch;
  delete process.env.USE_VERTEX_SEARCH;
});

test("searchProductsSemantically: 404 datastore missing → null (fallback graceful)", async () => {
  process.env.USE_VERTEX_SEARCH = "true";
  const origFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 404, async json() { return {}; } });
  const out = await searchProductsSemantically({ businessId: "biz1", query: "destornillador" });
  assert.equal(out, null);
  global.fetch = origFetch;
  delete process.env.USE_VERTEX_SEARCH;
});

test("searchProductsSemantically: 5xx → null (no throw)", async () => {
  process.env.USE_VERTEX_SEARCH = "true";
  const origFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 503, async json() { return {}; } });
  const out = await searchProductsSemantically({ businessId: "biz1", query: "destornillador" });
  assert.equal(out, null);
  global.fetch = origFetch;
  delete process.env.USE_VERTEX_SEARCH;
});

test("searchProductsSemantically: timeout abortado retorna null", async () => {
  process.env.USE_VERTEX_SEARCH = "true";
  const origFetch = global.fetch;
  global.fetch = async (_url, opts) => {
    if (opts && opts.signal) {
      await new Promise((resolve, reject) => {
        opts.signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    }
    return { ok: true, async json() { return { results: [] }; } };
  };
  const out = await searchProductsSemantically({ businessId: "biz1", query: "destornillador", timeoutMs: 50 });
  assert.equal(out, null);
  global.fetch = origFetch;
  delete process.env.USE_VERTEX_SEARCH;
});

test("searchProductsSemantically: filtra hits sin id o name", async () => {
  process.env.USE_VERTEX_SEARCH = "true";
  const origFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    async json() {
      return {
        results: [
          { document: { structData: { id: "p1", name: "Valid" } }, modelScore: { value: 0.9 } },
          { document: { structData: { id: "p2" } }, modelScore: { value: 0.8 } }, // no name
          { document: { structData: { name: "no id" } }, modelScore: { value: 0.7 } },
        ],
      };
    },
  });
  const hits = await searchProductsSemantically({ businessId: "biz1", query: "abc" });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, "p1");
  global.fetch = origFetch;
  delete process.env.USE_VERTEX_SEARCH;
});

// ── indexProducts ──────────────────────────────────────────────────────────

test("indexProducts: skipped cuando flag disabled", async () => {
  delete process.env.USE_VERTEX_SEARCH;
  const out = await indexProducts({ businessId: "b1", products: [{ id: "p1", name: "X" }] });
  assert.equal(out.ok, false);
  assert.match(out.error, /disabled/);
});

test("indexProducts: empty list ok", async () => {
  process.env.USE_VERTEX_SEARCH = "true";
  const out = await indexProducts({ businessId: "b1", products: [] });
  assert.equal(out.ok, true);
  assert.equal(out.indexed, 0);
  delete process.env.USE_VERTEX_SEARCH;
});

test("indexProducts: posts inlineSource con structData", async () => {
  process.env.USE_VERTEX_SEARCH = "true";
  const origFetch = global.fetch;
  let captured = null;
  global.fetch = async (url, opts) => {
    captured = { url, body: JSON.parse(opts.body) };
    return { ok: true, async json() { return {}; } };
  };
  await indexProducts({
    businessId: "biz1",
    products: [
      { id: "p1", name: "Tornillo M5", description: "5mm", sku: "T-M5", barcode: "1234" },
    ],
  });
  assert.match(captured.url, /:import$/);
  assert.equal(captured.body.inlineSource.documents[0].id, "p1");
  assert.equal(captured.body.inlineSource.documents[0].structData.name, "Tornillo M5");
  assert.equal(captured.body.reconciliationMode, "INCREMENTAL");
  global.fetch = origFetch;
  delete process.env.USE_VERTEX_SEARCH;
});

test("indexProducts: http error retorna ok:false", async () => {
  process.env.USE_VERTEX_SEARCH = "true";
  const origFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 500, async text() { return "internal"; } });
  const out = await indexProducts({ businessId: "b1", products: [{ id: "p1", name: "X" }] });
  assert.equal(out.ok, false);
  assert.match(out.error, /http_500/);
  global.fetch = origFetch;
  delete process.env.USE_VERTEX_SEARCH;
});
