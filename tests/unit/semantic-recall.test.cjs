// Tests para src/lib/semantic-recall.ts — pgvector RAG sobre customers.
// Mockeamos prisma + embeddings module via Module._cache injection
// (mismo patrón que owner-push.test.cjs).

process.env.AUTH_SECRET = process.env.AUTH_SECRET || "test-semantic-recall-secret-32-bytes-x";
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://test:test@localhost:5432/test";

const assert = require("node:assert/strict");
const test = require("node:test");
const Module = require("node:module");
const path = require("node:path");

const SUT_PATH = path.resolve(__dirname, "../../src/lib/semantic-recall.ts");
// NOTE: PRISMA_PATH must be the STUB path (tests/_stubs/prisma.js), NOT
// src/lib/prisma.ts. register.cjs redirects @/lib/prisma to the stub, so
// Module._cache is keyed on the stub path, not the source file.
// Additionally, module-hooks._load intercepts "@/lib/prisma" before cache
// lookup — we must also use setMockModule to override globalState.mocks.
const STUB_PRISMA_PATH = path.resolve(__dirname, "../../tests/_stubs/prisma.js");
const EMBEDDINGS_PATH = path.resolve(__dirname, "../../src/lib/embeddings.ts");

// POLLUTION GUARD: module-hooks.cjs (loaded by sibling files earlier in
// run-all.cjs) installs a Module._load interceptor that consults
// globalState.mocks BEFORE Module._cache. Files like session-version.test.cjs
// overwrite "@/lib/prisma" in globalState.mocks at top-level with a partial
// mock that lacks $queryRaw / $executeRaw, breaking these tests.
// Use setMockModule to ensure our mock takes priority.
let _setMockModule = (_k, _v) => {};
let _clearMockEntry = (_k) => {};
try {
  const hooks = require("../phase4/module-hooks.cjs");
  _setMockModule = hooks.setMockModule;
  _clearMockEntry = (key) => {
    const gs = globalThis.__veloraPhase4ModuleHooks;
    if (gs && gs.mocks) gs.mocks.delete(key);
  };
} catch { /* isolated run — Module._cache fallback is sufficient */ }

let _embedQueryReturn = null;
let _queryRawRows = [];
let _executeRawShouldThrow = false;

function installMocks() {
  const prismaMock = {
    $queryRaw: async () => _queryRawRows,
    $executeRaw: async () => {
      if (_executeRawShouldThrow) throw new Error("db down");
      return 1;
    },
  };
  const embeddingsMock = {
    embedQuery: async () => _embedQueryReturn,
    isEmbeddingsEnabled: () => process.env.USE_EMBEDDINGS === "true",
    toPgVectorLiteral: (v) => `[${v.join(",")}]`,
  };

  // Register via setMockModule so module-hooks._load returns our mock when the
  // SUT does require("@/lib/prisma"), overriding any stale globalState.mocks entry.
  _setMockModule("@/lib/prisma", { prisma: prismaMock });

  // Also inject into Module._cache at the resolved stub path as a fallback for
  // isolated runs where module-hooks is not installed.
  Module._cache[STUB_PRISMA_PATH] = {
    id: STUB_PRISMA_PATH, filename: STUB_PRISMA_PATH, loaded: true,
    exports: { prisma: prismaMock },
  };
  Module._cache[EMBEDDINGS_PATH] = {
    id: EMBEDDINGS_PATH, filename: EMBEDDINGS_PATH, loaded: true,
    exports: embeddingsMock,
  };
}

function resetCache() {
  delete Module._cache[SUT_PATH];
  delete Module._cache[STUB_PRISMA_PATH];
  delete Module._cache[EMBEDDINGS_PATH];
  // Remove our globalState.mocks entries so they don't bleed into the next test.
  _clearMockEntry("@/lib/prisma");
}

function loadSut() {
  resetCache();
  installMocks();
  return require(SUT_PATH);
}

// ── findCustomersByDescription ───────────────────────────────────────────

test("findCustomersByDescription: null cuando flag off", async () => {
  delete process.env.USE_EMBEDDINGS;
  const { findCustomersByDescription } = loadSut();
  const r = await findCustomersByDescription({ businessId: "b1", description: "la chica" });
  assert.equal(r, null);
});

test("findCustomersByDescription: null si description corta", async () => {
  process.env.USE_EMBEDDINGS = "true";
  _embedQueryReturn = { vector: [0.1, 0.2], dimensions: 2 };
  const { findCustomersByDescription } = loadSut();
  assert.equal(await findCustomersByDescription({ businessId: "b1", description: "ab" }), null);
  delete process.env.USE_EMBEDDINGS;
});

test("findCustomersByDescription: null si businessId falta", async () => {
  process.env.USE_EMBEDDINGS = "true";
  _embedQueryReturn = { vector: [0.1, 0.2], dimensions: 2 };
  const { findCustomersByDescription } = loadSut();
  assert.equal(await findCustomersByDescription({ businessId: "", description: "valid query" }), null);
  delete process.env.USE_EMBEDDINGS;
});

test("findCustomersByDescription: null si embedQuery devuelve null", async () => {
  process.env.USE_EMBEDDINGS = "true";
  _embedQueryReturn = null;
  const { findCustomersByDescription } = loadSut();
  assert.equal(await findCustomersByDescription({ businessId: "b1", description: "valid query" }), null);
  delete process.env.USE_EMBEDDINGS;
});

test("findCustomersByDescription: mapea similarity = 1 - distance, ordenado", async () => {
  process.env.USE_EMBEDDINGS = "true";
  _embedQueryReturn = { vector: [0.1, 0.2], dimensions: 2 };
  _queryRawRows = [
    { id: "c1", name: "Mariana Frutera", distance: 0.1 },
    { id: "c2", name: "Otro", distance: 0.4 },
  ];
  const { findCustomersByDescription } = loadSut();
  const hits = await findCustomersByDescription({ businessId: "b1", description: "la chica de plantas" });
  assert.ok(hits);
  assert.equal(hits.length, 2);
  assert.equal(hits[0].id, "c1");
  assert.equal(Math.round(hits[0].similarity * 100) / 100, 0.9);
  assert.equal(Math.round(hits[1].similarity * 100) / 100, 0.6);
  delete process.env.USE_EMBEDDINGS;
});

test("findCustomersByDescription: rows vacías → null (cold start)", async () => {
  process.env.USE_EMBEDDINGS = "true";
  _embedQueryReturn = { vector: [0.1, 0.2], dimensions: 2 };
  _queryRawRows = [];
  const { findCustomersByDescription } = loadSut();
  assert.equal(await findCustomersByDescription({ businessId: "b1", description: "x query" }), null);
  delete process.env.USE_EMBEDDINGS;
});

// ── buildCustomerEmbedText ───────────────────────────────────────────────

test("buildCustomerEmbedText: solo nombre", () => {
  const { buildCustomerEmbedText } = loadSut();
  assert.equal(buildCustomerEmbedText({ name: "Juan" }), "Juan");
});

test("buildCustomerEmbedText: nombre + email + tel", () => {
  const { buildCustomerEmbedText } = loadSut();
  assert.equal(
    buildCustomerEmbedText({ name: "Juan", email: "juan@ej.com", phone: "+5491111111111" }),
    "Juan | email: juan@ej.com | tel: +5491111111111",
  );
});

test("buildCustomerEmbedText: omits nullables", () => {
  const { buildCustomerEmbedText } = loadSut();
  assert.equal(
    buildCustomerEmbedText({ name: "Juan", email: null, phone: "+5491111111111" }),
    "Juan | tel: +5491111111111",
  );
});

// ── persistCustomerEmbedding ─────────────────────────────────────────────

test("persistCustomerEmbedding: false cuando vector vacío", async () => {
  const { persistCustomerEmbedding } = loadSut();
  assert.equal(
    await persistCustomerEmbedding({ businessId: "b1", customerId: "c1", embedding: [] }),
    false,
  );
});

test("persistCustomerEmbedding: false cuando businessId falta", async () => {
  const { persistCustomerEmbedding } = loadSut();
  assert.equal(
    await persistCustomerEmbedding({ businessId: "", customerId: "c1", embedding: [0.1] }),
    false,
  );
});

test("persistCustomerEmbedding: true cuando $executeRaw OK", async () => {
  _executeRawShouldThrow = false;
  const { persistCustomerEmbedding } = loadSut();
  assert.equal(
    await persistCustomerEmbedding({ businessId: "b1", customerId: "c1", embedding: [0.1, 0.2, 0.3] }),
    true,
  );
});

test("persistCustomerEmbedding: false si executeRaw throws", async () => {
  _executeRawShouldThrow = true;
  const { persistCustomerEmbedding } = loadSut();
  assert.equal(
    await persistCustomerEmbedding({ businessId: "b1", customerId: "c1", embedding: [0.1] }),
    false,
  );
  _executeRawShouldThrow = false;
});
