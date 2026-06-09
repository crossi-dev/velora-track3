// Tests para src/lib/embeddings.ts — Vertex text-embedding-004 client.
// Cierra la base del gap "RAG weak" del Track 3 audit.

process.env.AUTH_SECRET = process.env.AUTH_SECRET || "test-embeddings-secret-32-bytes-long-x";
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://test:test@localhost:5432/test";

const assert = require("node:assert/strict");
const test = require("node:test");

const Module = require("module");
const origLoad = Module._load;
Module._load = function (request, parent, ...rest) {
  if (request === "google-auth-library") {
    return {
      GoogleAuth: class {
        async getClient() {
          return { async getAccessToken() { return { token: "fake" }; } };
        }
      },
    };
  }
  return origLoad.call(this, request, parent, ...rest);
};

const {
  embedText,
  embedQuery,
  isEmbeddingsEnabled,
  toPgVectorLiteral,
} = require("../../src/lib/embeddings.ts");

process.on("exit", () => { Module._load = origLoad; });

// ── Flag gating ──────────────────────────────────────────────────────────

test("isEmbeddingsEnabled: false default", () => {
  delete process.env.USE_EMBEDDINGS;
  assert.equal(isEmbeddingsEnabled(), false);
});

test("isEmbeddingsEnabled: true cuando 'true'", () => {
  process.env.USE_EMBEDDINGS = "true";
  assert.equal(isEmbeddingsEnabled(), true);
  delete process.env.USE_EMBEDDINGS;
});

// ── embedText short-circuits ─────────────────────────────────────────────

test("embedText: null cuando flag off", async () => {
  delete process.env.USE_EMBEDDINGS;
  const r = await embedText("hola");
  assert.equal(r, null);
});

test("embedText: null cuando texto vacío", async () => {
  process.env.USE_EMBEDDINGS = "true";
  assert.equal(await embedText(""), null);
  assert.equal(await embedText("   "), null);
  delete process.env.USE_EMBEDDINGS;
});

// ── embedText happy path ─────────────────────────────────────────────────

test("embedText: parsea response y devuelve vector + dimensions", async () => {
  process.env.USE_EMBEDDINGS = "true";
  const origFetch = global.fetch;
  let captured = null;
  global.fetch = async (url, opts) => {
    captured = { url, body: JSON.parse(opts.body) };
    return {
      ok: true,
      async json() {
        return {
          predictions: [{ embeddings: { values: new Array(768).fill(0.1) } }],
        };
      },
    };
  };
  const out = await embedText("Mariana, frutera");
  assert.ok(out);
  assert.equal(out.dimensions, 768);
  assert.equal(out.vector.length, 768);
  assert.equal(captured.body.instances[0].task_type, "RETRIEVAL_DOCUMENT");
  assert.equal(captured.body.instances[0].content, "Mariana, frutera");
  global.fetch = origFetch;
  delete process.env.USE_EMBEDDINGS;
});

test("embedText: 5xx → null sin throw", async () => {
  process.env.USE_EMBEDDINGS = "true";
  const origFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 500, async json() { return {}; } });
  assert.equal(await embedText("x"), null);
  global.fetch = origFetch;
  delete process.env.USE_EMBEDDINGS;
});

test("embedText: response sin predictions → null", async () => {
  process.env.USE_EMBEDDINGS = "true";
  const origFetch = global.fetch;
  global.fetch = async () => ({ ok: true, async json() { return {}; } });
  assert.equal(await embedText("x"), null);
  global.fetch = origFetch;
  delete process.env.USE_EMBEDDINGS;
});

test("embedText: trunca al límite de 8000 chars", async () => {
  process.env.USE_EMBEDDINGS = "true";
  const origFetch = global.fetch;
  let captured = null;
  global.fetch = async (_url, opts) => {
    captured = JSON.parse(opts.body);
    return {
      ok: true,
      async json() {
        return { predictions: [{ embeddings: { values: [0.1] } }] };
      },
    };
  };
  const huge = "a".repeat(20000);
  await embedText(huge);
  assert.equal(captured.instances[0].content.length, 8000);
  global.fetch = origFetch;
  delete process.env.USE_EMBEDDINGS;
});

// ── embedQuery: distinct task_type ───────────────────────────────────────

test("embedQuery: usa task_type RETRIEVAL_QUERY (no DOCUMENT)", async () => {
  process.env.USE_EMBEDDINGS = "true";
  const origFetch = global.fetch;
  let captured = null;
  global.fetch = async (_url, opts) => {
    captured = JSON.parse(opts.body);
    return {
      ok: true,
      async json() {
        return { predictions: [{ embeddings: { values: [0.5, 0.5] } }] };
      },
    };
  };
  await embedQuery("la chica de las plantas");
  assert.equal(captured.instances[0].task_type, "RETRIEVAL_QUERY");
  global.fetch = origFetch;
  delete process.env.USE_EMBEDDINGS;
});

// ── toPgVectorLiteral ────────────────────────────────────────────────────

test("toPgVectorLiteral: format pgvector literal '[a,b,c]'", () => {
  assert.equal(toPgVectorLiteral([1, 2.5, -0.3]), "[1,2.5,-0.3]");
  assert.equal(toPgVectorLiteral([0]), "[0]");
});
