"use strict";
// Unit tests — Correo Argentino preflight credential validation.
//
// Tests cover:
//   Part 1: CorreoPreflightError class shape
//   Part 2: validateCorreoCreds — two-step flow (Token → Users/validate)
//   Part 3: error classification (401/403/5xx/network)
//   Part 4: password sentinel is NOT present in any error message

const assert = require("node:assert/strict");
const test   = require("node:test");

const {
  CorreoPreflightError,
  validateCorreoCreds,
} = require("../../src/app/api/integrations/logistica/connect/_lib/correo-preflight.ts");

// ── Part 1: CorreoPreflightError shape ────────────────────────────────────────

test("CorreoPreflightError — is an Error with spanishMessage and transient fields", () => {
  const err = new CorreoPreflightError("Correo rechazó esas credenciales.");
  assert.ok(err instanceof Error);
  assert.ok(err instanceof CorreoPreflightError);
  assert.equal(err.name, "CorreoPreflightError");
  assert.equal(err.spanishMessage, "Correo rechazó esas credenciales.");
  assert.equal(err.transient, false);
});

test("CorreoPreflightError — transient=true flag is preserved", () => {
  const err = new CorreoPreflightError("Timeout.", true);
  assert.equal(err.transient, true);
});

// ── Fetch mock helpers ────────────────────────────────────────────────────────

let savedFetch;
let fetchCallCount = 0;
let mockResponses = [];

function setupMultiFetch(responses) {
  savedFetch = globalThis.fetch;
  fetchCallCount = 0;
  mockResponses = responses;
  globalThis.fetch = async (_url, _init) => {
    const idx = fetchCallCount++;
    const r = mockResponses[idx] ?? mockResponses[mockResponses.length - 1];
    const bodyStr = typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? {});
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      text: async () => bodyStr,
      json: async () => (bodyStr ? JSON.parse(bodyStr) : {}),
    };
  };
}

function restoreFetch() {
  if (savedFetch !== undefined) globalThis.fetch = savedFetch;
}

// ── Part 2: Two-step flow (Token + Users/validate) ────────────────────────────

test("validateCorreoCreds — Token 200 + validate 200 with customerId → resolves with customerId", async () => {
  setupMultiFetch([
    { status: 200, body: { access_token: "TOK_ABC", token_type: "Bearer", expires_in: 3600 } },
    { status: 200, body: { customerId: "CUST-123", name: "Mi Negocio" } },
  ]);
  try {
    const result = await validateCorreoCreds("user@example.com", "s3cr3t");
    assert.equal(result.customerId, "CUST-123");
  } finally {
    restoreFetch();
  }
});

test("validateCorreoCreds — Token 200 but validate returns no customerId → CorreoPreflightError (not transient)", async () => {
  setupMultiFetch([
    { status: 200, body: { access_token: "TOK_ABC", token_type: "Bearer", expires_in: 3600 } },
    { status: 200, body: { customerId: "", name: "" } },
  ]);
  try {
    await assert.rejects(
      () => validateCorreoCreds("user@example.com", "pass"),
      (err) => {
        assert.ok(err instanceof CorreoPreflightError);
        assert.equal(err.transient, false);
        assert.ok(err.spanishMessage.toLowerCase().includes("customerid") || err.spanishMessage.toLowerCase().includes("customer"));
        return true;
      },
    );
  } finally {
    restoreFetch();
  }
});

test("validateCorreoCreds — Token 200 but missing access_token → CorreoPreflightError (not transient)", async () => {
  setupMultiFetch([
    { status: 200, body: { token_type: "Bearer" } }, // no access_token
  ]);
  try {
    await assert.rejects(
      () => validateCorreoCreds("user", "pass"),
      (err) => {
        assert.ok(err instanceof CorreoPreflightError);
        assert.equal(err.transient, false);
        return true;
      },
    );
  } finally {
    restoreFetch();
  }
});

// ── Part 3: Error classification ──────────────────────────────────────────────

test("validateCorreoCreds — Token 401 → CorreoPreflightError (not transient)", async () => {
  setupMultiFetch([{ status: 401, body: "Unauthorized" }]);
  try {
    await assert.rejects(
      () => validateCorreoCreds("bad-user", "bad-pass"),
      (err) => {
        assert.ok(err instanceof CorreoPreflightError);
        assert.equal(err.transient, false);
        assert.ok(err.spanishMessage.includes("rechazó") || err.spanishMessage.includes("credenciales"));
        return true;
      },
    );
  } finally {
    restoreFetch();
  }
});

test("validateCorreoCreds — Token 403 → CorreoPreflightError (not transient)", async () => {
  setupMultiFetch([{ status: 403, body: "Forbidden" }]);
  try {
    await assert.rejects(
      () => validateCorreoCreds("user", "pass"),
      (err) => {
        assert.ok(err instanceof CorreoPreflightError);
        assert.equal(err.transient, false);
        return true;
      },
    );
  } finally {
    restoreFetch();
  }
});

test("validateCorreoCreds — Token 500 → CorreoPreflightError (transient=true)", async () => {
  setupMultiFetch([{ status: 500, body: "Internal Server Error" }]);
  try {
    await assert.rejects(
      () => validateCorreoCreds("user", "pass"),
      (err) => {
        assert.ok(err instanceof CorreoPreflightError);
        assert.equal(err.transient, true);
        assert.ok(err.spanishMessage.includes("servidor"));
        return true;
      },
    );
  } finally {
    restoreFetch();
  }
});

test("validateCorreoCreds — Token 404 → CorreoPreflightError (transient=true)", async () => {
  setupMultiFetch([{ status: 404, body: "Not Found" }]);
  try {
    await assert.rejects(
      () => validateCorreoCreds("user", "pass"),
      (err) => {
        assert.ok(err instanceof CorreoPreflightError);
        assert.equal(err.transient, true);
        return true;
      },
    );
  } finally {
    restoreFetch();
  }
});

test("validateCorreoCreds — network abort → CorreoPreflightError (transient=true)", async () => {
  savedFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    const e = new Error("abort");
    e.name = "AbortError";
    throw e;
  };
  try {
    await assert.rejects(
      () => validateCorreoCreds("user", "pass"),
      (err) => {
        assert.ok(err instanceof CorreoPreflightError);
        assert.equal(err.transient, true);
        return true;
      },
    );
  } finally {
    restoreFetch();
  }
});

test("validateCorreoCreds — validate step 401 → CorreoPreflightError (transient=true)", async () => {
  setupMultiFetch([
    { status: 200, body: { access_token: "TOK", token_type: "Bearer", expires_in: 3600 } },
    { status: 401, body: "Unauthorized" },
  ]);
  try {
    await assert.rejects(
      () => validateCorreoCreds("user", "pass"),
      (err) => {
        assert.ok(err instanceof CorreoPreflightError);
        // Unexpected 401 after getting token → treat as transient
        assert.equal(err.transient, true);
        return true;
      },
    );
  } finally {
    restoreFetch();
  }
});

// ── Part 4: password never leaks into error messages ─────────────────────────

test("validateCorreoCreds — password is NOT present in error message on 401", async () => {
  const SECRET = "super-secret-correo-password-12345";
  setupMultiFetch([{ status: 401, body: "Unauthorized" }]);
  try {
    let thrown = null;
    try {
      await validateCorreoCreds("usuario", SECRET);
    } catch (e) {
      thrown = e;
    }
    assert.ok(thrown instanceof CorreoPreflightError);
    assert.ok(!thrown.spanishMessage.includes(SECRET), "Password must not appear in spanishMessage");
    assert.ok(!thrown.message.includes(SECRET), "Password must not appear in Error.message");
  } finally {
    restoreFetch();
  }
});

test("validateCorreoCreds — password is NOT present in error message on network error", async () => {
  const SECRET = "another-secret-99999";
  savedFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("ECONNRESET"); };
  try {
    let thrown = null;
    try {
      await validateCorreoCreds("usuario", SECRET);
    } catch (e) {
      thrown = e;
    }
    assert.ok(thrown instanceof CorreoPreflightError);
    assert.ok(!thrown.spanishMessage.includes(SECRET));
    assert.ok(!thrown.message.includes(SECRET));
  } finally {
    restoreFetch();
  }
});
