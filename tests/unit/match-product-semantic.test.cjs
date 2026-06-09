// Tests para match-product-by-name.semantic.ts — el path server-only que
// usa Vertex AI Search como fallback al SQL fuzzy.

process.env.AUTH_SECRET = process.env.AUTH_SECRET || "test-match-semantic-secret-32-bytes-x";
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://test:test@localhost:5432/test";

const assert = require("node:assert/strict");
const test = require("node:test");
const Module = require("node:module");
const path = require("node:path");

const SUT_PATH = path.resolve(
  __dirname,
  "../../src/app/api/business-assistant/_lib/match-product-by-name.semantic.ts",
);
const VERTEX_SEARCH_PATH = path.resolve(__dirname, "../../src/lib/vertex-search.ts");

function loadSut(opts) {
  const { hits = [], enabled = false, captureCalled } = opts || {};
  delete Module._cache[SUT_PATH];
  delete Module._cache[VERTEX_SEARCH_PATH];
  Module._cache[VERTEX_SEARCH_PATH] = {
    id: VERTEX_SEARCH_PATH,
    filename: VERTEX_SEARCH_PATH,
    loaded: true,
    exports: {
      searchProductsSemantically: async () => {
        if (captureCalled) captureCalled.value = true;
        return hits;
      },
      isVertexSearchEnabled: () => enabled,
      indexProducts: async () => ({ ok: true, indexed: 0 }),
    },
  };
  return require(SUT_PATH);
}

const CATALOG = [
  { id: "p1", name: "Desarmador Phillips" },
  { id: "p2", name: "Atornillador estrella" },
  { id: "p3", name: "Llave Allen 5mm" },
  { id: "p4", name: "Cubierta Firestone 175/65" },
  { id: "p5", name: "Pintura blanca látex" },
];

// ── SQL fuzzy short-circuits before Vertex ─────────────────────────────

test("matchProductByNameSemantic: exact match no llama a Vertex", async () => {
  const called = { value: false };
  const { matchProductByNameSemantic } = loadSut({ enabled: true, captureCalled: called });
  const out = await matchProductByNameSemantic("Llave Allen 5mm", CATALOG, "biz_1");
  assert.equal(out?.id, "p3");
  assert.equal(called.value, false);
});

test("matchProductByNameSemantic: substring match no llama a Vertex", async () => {
  const called = { value: false };
  const { matchProductByNameSemantic } = loadSut({ enabled: true, captureCalled: called });
  const out = await matchProductByNameSemantic("desarmador", CATALOG, "biz_1");
  assert.equal(out?.id, "p1");
  assert.equal(called.value, false);
});

// ── Vertex fallback ────────────────────────────────────────────────────

test("matchProductByNameSemantic: SQL null + Vertex disabled → null", async () => {
  const { matchProductByNameSemantic } = loadSut({ enabled: false });
  const out = await matchProductByNameSemantic("destornillador phillips", CATALOG, "biz_1");
  assert.equal(out, null);
});

test("matchProductByNameSemantic: SQL null + Vertex enabled + score >=0.7 + id en catálogo → hit", async () => {
  const { matchProductByNameSemantic } = loadSut({
    enabled: true,
    hits: [{ id: "p1", name: "Desarmador Phillips", score: 0.85 }],
  });
  const out = await matchProductByNameSemantic("destornillador phillips", CATALOG, "biz_1");
  assert.equal(out?.id, "p1");
  assert.equal(out?.name, "Desarmador Phillips");
});

test("matchProductByNameSemantic: score < 0.7 → null (no guess)", async () => {
  const { matchProductByNameSemantic } = loadSut({
    enabled: true,
    hits: [{ id: "p1", name: "Desarmador Phillips", score: 0.5 }],
  });
  const out = await matchProductByNameSemantic("herramienta nueva", CATALOG, "biz_1");
  assert.equal(out, null);
});

test("matchProductByNameSemantic: hit con id NO en catálogo → null (defense vs stale index)", async () => {
  const { matchProductByNameSemantic } = loadSut({
    enabled: true,
    hits: [{ id: "p_stale_999", name: "Producto borrado", score: 0.9 }],
  });
  const out = await matchProductByNameSemantic("cualquier cosa nueva", CATALOG, "biz_1");
  assert.equal(out, null);
});

test("matchProductByNameSemantic: businessId undefined → no llama Vertex", async () => {
  const called = { value: false };
  const { matchProductByNameSemantic } = loadSut({ enabled: true, captureCalled: called });
  const out = await matchProductByNameSemantic("destornillador phillips", CATALOG, undefined);
  assert.equal(out, null);
  assert.equal(called.value, false);
});

test("matchProductByNameSemantic: hits vacío → null", async () => {
  const { matchProductByNameSemantic } = loadSut({ enabled: true, hits: [] });
  const out = await matchProductByNameSemantic("xyz semantic miss", CATALOG, "biz_1");
  assert.equal(out, null);
});

test("matchProductByNameSemantic: top hit (orden desc por score)", async () => {
  const { matchProductByNameSemantic } = loadSut({
    enabled: true,
    hits: [
      { id: "p4", name: "Cubierta Firestone 175/65", score: 0.92 },
      { id: "p1", name: "Desarmador Phillips", score: 0.71 },
    ],
  });
  const out = await matchProductByNameSemantic("neumatico firestone", CATALOG, "biz_1");
  assert.equal(out?.id, "p4");
});

test("matchProductByNameSemantic: catálogo vacío → null", async () => {
  const { matchProductByNameSemantic } = loadSut({ enabled: true, hits: [] });
  const out = await matchProductByNameSemantic("destornillador", [], "biz_1");
  assert.equal(out, null);
});
