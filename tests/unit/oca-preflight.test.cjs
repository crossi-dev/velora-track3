"use strict";
// Unit tests — OCA preflight credential validation.
//
// Mirrors andreani-preflight tests (Part 3 + Part 4 of integration-preflight.test.cjs).
// Tests cover:
//   Part 1: OcaPreflightError class shape
//   Part 2: validateOcaCreds — success and failure paths (mocked fetch)
//   Part 3: password sentinel is NOT present in any error message

const assert = require("node:assert/strict");
const test   = require("node:test");

const {
  OcaPreflightError,
  validateOcaCreds,
} = require("../../src/app/api/integrations/logistica/connect/_lib/oca-preflight.ts");

// ── Part 1: OcaPreflightError shape ──────────────────────────────────────────

test("OcaPreflightError — is an Error with spanishMessage and transient fields", () => {
  const err = new OcaPreflightError("OCA rechazó esas credenciales.");
  assert.ok(err instanceof Error);
  assert.ok(err instanceof OcaPreflightError);
  assert.equal(err.name, "OcaPreflightError");
  assert.equal(err.spanishMessage, "OCA rechazó esas credenciales.");
  assert.equal(err.transient, false);
});

test("OcaPreflightError — transient=true flag is preserved", () => {
  const err = new OcaPreflightError("Timeout.", true);
  assert.equal(err.transient, true);
});

// ── Part 2: validateOcaCreds — success and failure paths ─────────────────────

let savedFetch;

function mockFetch(statusCode, body = "") {
  savedFetch = globalThis.fetch;
  globalThis.fetch = async (_url, _init) => ({
    ok: statusCode >= 200 && statusCode < 300,
    status: statusCode,
    text: async () => body,
    json: async () => (body ? JSON.parse(body) : {}),
  });
}

function restoreFetch() {
  if (savedFetch !== undefined) {
    globalThis.fetch = savedFetch;
  }
}

test("validateOcaCreds — 200 with success=true and token → resolves (no error)", async () => {
  mockFetch(200, JSON.stringify({ success: true, message: "Success", result: "TOKEN_ABC123" }));
  try {
    await assert.doesNotReject(validateOcaCreds("usuario", "secret"));
  } finally {
    restoreFetch();
  }
});

test("validateOcaCreds — 200 with success=false → OcaPreflightError (not transient)", async () => {
  mockFetch(200, JSON.stringify({ success: false, message: "Invalid credentials", result: "" }));
  try {
    await assert.rejects(
      () => validateOcaCreds("bad-user", "bad-pass"),
      (err) => {
        assert.ok(err instanceof OcaPreflightError);
        assert.equal(err.transient, false);
        assert.ok(err.spanishMessage.includes("OCA no autorizó") || err.spanishMessage.includes("credenciales"));
        return true;
      },
    );
  } finally {
    restoreFetch();
  }
});

test("validateOcaCreds — 200 with empty token string → OcaPreflightError (not transient)", async () => {
  mockFetch(200, JSON.stringify({ success: true, message: "ok", result: "" }));
  try {
    await assert.rejects(
      () => validateOcaCreds("user", "pass"),
      (err) => {
        assert.ok(err instanceof OcaPreflightError);
        assert.equal(err.transient, false);
        return true;
      },
    );
  } finally {
    restoreFetch();
  }
});

test("validateOcaCreds — 401 → OcaPreflightError (not transient)", async () => {
  mockFetch(401, "Unauthorized");
  try {
    await assert.rejects(
      () => validateOcaCreds("bad-user", "bad-pass"),
      (err) => {
        assert.ok(err instanceof OcaPreflightError);
        assert.equal(err.transient, false);
        assert.ok(err.spanishMessage.includes("OCA rechazó"));
        return true;
      },
    );
  } finally {
    restoreFetch();
  }
});

test("validateOcaCreds — 403 → OcaPreflightError (not transient)", async () => {
  mockFetch(403, "Forbidden");
  try {
    await assert.rejects(
      () => validateOcaCreds("user", "pass"),
      (err) => {
        assert.ok(err instanceof OcaPreflightError);
        assert.equal(err.transient, false);
        return true;
      },
    );
  } finally {
    restoreFetch();
  }
});

test("validateOcaCreds — 500 → OcaPreflightError (transient=true)", async () => {
  mockFetch(500, "Internal Server Error");
  try {
    await assert.rejects(
      () => validateOcaCreds("user", "pass"),
      (err) => {
        assert.ok(err instanceof OcaPreflightError);
        assert.equal(err.transient, true);
        assert.ok(err.spanishMessage.includes("error de servidor"));
        return true;
      },
    );
  } finally {
    restoreFetch();
  }
});

test("validateOcaCreds — 404 → OcaPreflightError (transient=true)", async () => {
  mockFetch(404, "Not Found");
  try {
    await assert.rejects(
      () => validateOcaCreds("user", "pass"),
      (err) => {
        assert.ok(err instanceof OcaPreflightError);
        assert.equal(err.transient, true);
        return true;
      },
    );
  } finally {
    restoreFetch();
  }
});

test("validateOcaCreds — network abort → OcaPreflightError (transient=true)", async () => {
  savedFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    const e = new Error("abort");
    e.name = "AbortError";
    throw e;
  };
  try {
    await assert.rejects(
      () => validateOcaCreds("user", "pass"),
      (err) => {
        assert.ok(err instanceof OcaPreflightError);
        assert.equal(err.transient, true);
        return true;
      },
    );
  } finally {
    restoreFetch();
  }
});

// ── Part 3: password never leaks into error messages ─────────────────────────

test("validateOcaCreds — password is NOT present in error message on 401", async () => {
  const SECRET = "super-secret-oca-password-12345";
  mockFetch(401, "Unauthorized");
  try {
    let thrown = null;
    try {
      await validateOcaCreds("usuario", SECRET);
    } catch (e) {
      thrown = e;
    }
    assert.ok(thrown instanceof OcaPreflightError);
    assert.ok(!thrown.spanishMessage.includes(SECRET), "Password must not appear in spanishMessage");
    assert.ok(!thrown.message.includes(SECRET), "Password must not appear in Error.message");
  } finally {
    restoreFetch();
  }
});
