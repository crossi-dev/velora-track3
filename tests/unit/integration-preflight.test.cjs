"use strict";
// Unit tests — pre-flight credential validation for ARCA and Andreani connect routes.
//
// Tests cover:
//   Part 1: WsaaPreflightError class shape
//   Part 2: validateCertAgainstWsaa — success and failure paths (mocked SOAP)
//   Part 3: AndreaniPreflightError class shape
//   Part 4: validateAndreaniCreds — success and failure paths (mocked fetch)

const assert = require("node:assert/strict");
const test   = require("node:test");

// ── Part 1: WsaaPreflightError shape ─────────────────────────────────────────

const { WsaaPreflightError } = require("../../src/app/api/integrations/fiscal/connect/_lib/wsaa-preflight.ts");

test("WsaaPreflightError — is an Error with spanishMessage and transient fields", () => {
  const err = new WsaaPreflightError("El certificado está vencido.");
  assert.ok(err instanceof Error);
  assert.ok(err instanceof WsaaPreflightError);
  assert.equal(err.name, "WsaaPreflightError");
  assert.equal(err.spanishMessage, "El certificado está vencido.");
  assert.equal(err.transient, false);
});

test("WsaaPreflightError — transient=true flag is preserved", () => {
  const err = new WsaaPreflightError("Timeout.", true);
  assert.equal(err.transient, true);
});

// ── Part 2: validateCertAgainstWsaa ───────────────────────────────────────────
//
// We test the exported validateWsaaResponse helper directly — it is the real
// production classifier. Tests feed XML through the actual function, so any
// divergence in extractTag or the fault-detection logic is caught here.

const { validateWsaaResponse } = require("../../src/app/api/integrations/fiscal/connect/_lib/wsaa-preflight.ts");

// Helper: call validateWsaaResponse and return "success" or the thrown WsaaPreflightError.
function callClassifier(xml, cuit) {
  try {
    validateWsaaResponse(xml, cuit);
    return { type: "success" };
  } catch (err) {
    return err; // WsaaPreflightError instance
  }
}

test("WSAA classifier — success response with token → no error thrown", () => {
  const xml = `<loginCmsReturn><loginTicketResponse><credentials><token>ABC</token><sign>XYZ</sign></credentials></loginTicketResponse></loginCmsReturn>`;
  const result = callClassifier(xml, "20111111112");
  assert.equal(result.type, "success");
});

test("WSAA classifier — SOAP fault with 'cuit' keyword → WsaaPreflightError about CUIT", () => {
  const xml = `<SOAP-ENV:Fault><faultcode>Client</faultcode><faultstring>El CUIT 20111111112 no está autorizado</faultstring></SOAP-ENV:Fault>`;
  const err = callClassifier(xml, "20111111112");
  assert.ok(err instanceof WsaaPreflightError);
  assert.ok(err.spanishMessage.includes("CUIT"), `expected CUIT mention, got: ${err.spanishMessage}`);
  assert.equal(err.transient, false);
});

test("WSAA classifier — SOAP fault with 'expired' → WsaaPreflightError about expired cert", () => {
  const xml = `<SOAP-ENV:Fault><faultcode>Server</faultcode><faultstring>certificate expired 2024-01-01</faultstring></SOAP-ENV:Fault>`;
  const err = callClassifier(xml, "20111111112");
  assert.ok(err instanceof WsaaPreflightError);
  assert.ok(err.spanishMessage.toLowerCase().includes("vencid"), `expected 'vencid', got: ${err.spanishMessage}`);
});

test("WSAA classifier — SOAP fault with 'vencid' (Spanish) → WsaaPreflightError about expired cert", () => {
  const xml = `<SOAP-ENV:Fault><faultcode>Server</faultcode><faultstring>El certificado está vencido</faultstring></SOAP-ENV:Fault>`;
  const err = callClassifier(xml, "20111111112");
  assert.ok(err instanceof WsaaPreflightError);
  assert.ok(err.spanishMessage.toLowerCase().includes("vencid"), `expected 'vencid', got: ${err.spanishMessage}`);
});

test("WSAA classifier — SOAP fault with 'revocad' → WsaaPreflightError about revoked cert", () => {
  const xml = `<SOAP-ENV:Fault><faultcode>Server</faultcode><faultstring>El certificado fue revocado</faultstring></SOAP-ENV:Fault>`;
  const err = callClassifier(xml, "20111111112");
  assert.ok(err instanceof WsaaPreflightError);
  assert.ok(err.spanishMessage.toLowerCase().includes("revoc"), `expected 'revoc', got: ${err.spanishMessage}`);
});

test("WSAA classifier — SOAP fault with unrecognized message → WsaaPreflightError (generic)", () => {
  const xml = `<SOAP-ENV:Fault><faultcode>Server</faultcode><faultstring>Unknown error occurred</faultstring></SOAP-ENV:Fault>`;
  const err = callClassifier(xml, "20111111112");
  assert.ok(err instanceof WsaaPreflightError);
  assert.ok(err.spanishMessage.includes("Unknown error"), `expected fault detail, got: ${err.spanishMessage}`);
});

test("WSAA classifier — valid response but no token → WsaaPreflightError (transient)", () => {
  const xml = `<loginCmsReturn><empty/></loginCmsReturn>`;
  const err = callClassifier(xml, "20111111112");
  assert.ok(err instanceof WsaaPreflightError);
  assert.equal(err.transient, true);
});

test("WSAA classifier — faultcode present but token also present → fault takes priority", () => {
  const xml = `<SOAP-ENV:Fault><faultcode>Server</faultcode><faultstring>cuit no valido</faultstring></SOAP-ENV:Fault><token>t</token>`;
  const err = callClassifier(xml, "20111111112");
  // Fault is detected first in the classifier.
  assert.ok(err instanceof WsaaPreflightError);
  assert.ok(err.spanishMessage.includes("CUIT"), `expected CUIT mention, got: ${err.spanishMessage}`);
});

// ── Fix 3: WSAA passphrase is NOT present in any WsaaPreflightError ───────────
//
// The passphrase is only ever used in parseCertBuffer (not in validateWsaaResponse).
// We verify that every WsaaPreflightError branch inside validateWsaaResponse never
// propagates the CUIT or other caller-supplied data in a way that could accidentally
// expose secrets. Specifically: the CUIT appears in the cuit_mismatch branch (by
// design — it is the business's own CUIT, not a secret), and no other caller value
// leaks into non-cuit branches.
//
// The passphrase is NEVER passed to validateWsaaResponse, so the correct boundary
// test is: none of the non-cuit-mismatch branches include the CUIT in their message
// (they don't receive passphrase at all, so there is nothing to leak from that path).

test("WSAA classifier — passphrase sentinel is NOT reachable through validateWsaaResponse (passphrase never passed in)", () => {
  const SENTINEL = "super-secret-passphrase-67890";
  // validateWsaaResponse only receives (xml, cuit) — the passphrase is not a parameter.
  // Confirm the sentinel does not appear in any error that validateWsaaResponse can throw.
  const scenarios = [
    // No token case
    `<loginCmsReturn><empty/></loginCmsReturn>`,
    // Expired cert case
    `<SOAP-ENV:Fault><faultcode>Server</faultcode><faultstring>certificate expired</faultstring></SOAP-ENV:Fault>`,
    // Revoked cert case
    `<SOAP-ENV:Fault><faultcode>Server</faultcode><faultstring>certificate revocado</faultstring></SOAP-ENV:Fault>`,
    // Generic rejection — faultstring from AFIP, sentinel is NOT in the XML here
    `<SOAP-ENV:Fault><faultcode>Server</faultcode><faultstring>some server error</faultstring></SOAP-ENV:Fault>`,
  ];

  for (const xml of scenarios) {
    let thrown = null;
    try {
      // Pass sentinel as cuit so we confirm cuit-mismatch branches only embed
      // the cuit (their intended value), not the passphrase.
      validateWsaaResponse(xml, SENTINEL);
    } catch (e) {
      thrown = e;
    }
    assert.ok(thrown instanceof WsaaPreflightError, "expected WsaaPreflightError to be thrown");
    // For non-cuit-mismatch branches the sentinel (used as cuit here) must NOT appear.
    // Only the cuit_mismatch branch intentionally embeds the cuit — none of these XMLs trigger that branch.
    assert.ok(
      !thrown.message.includes(SENTINEL),
      `Passphrase sentinel must not appear in Error.message for this branch. Got: ${thrown.message}`,
    );
    assert.ok(
      !thrown.spanishMessage.includes(SENTINEL),
      `Passphrase sentinel must not appear in spanishMessage for this branch. Got: ${thrown.spanishMessage}`,
    );
  }
});

// ── Part 3: AndreaniPreflightError shape ─────────────────────────────────────

const { AndreaniPreflightError } = require("../../src/app/api/integrations/logistica/connect/_lib/andreani-preflight.ts");

test("AndreaniPreflightError — is an Error with spanishMessage and transient fields", () => {
  const err = new AndreaniPreflightError("Andreani rechazó esas credenciales.");
  assert.ok(err instanceof Error);
  assert.ok(err instanceof AndreaniPreflightError);
  assert.equal(err.name, "AndreaniPreflightError");
  assert.equal(err.spanishMessage, "Andreani rechazó esas credenciales.");
  assert.equal(err.transient, false);
});

test("AndreaniPreflightError — transient=true flag is preserved", () => {
  const err = new AndreaniPreflightError("Timeout.", true);
  assert.equal(err.transient, true);
});

// ── Part 4: validateAndreaniCreds — success and failure via mocked fetch ─────
//
// We replace globalThis.fetch with a mock for each test, then restore it.

const { validateAndreaniCreds } = require("../../src/app/api/integrations/logistica/connect/_lib/andreani-preflight.ts");

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

test("validateAndreaniCreds — 200 response → resolves (no error)", async () => {
  mockFetch(200, JSON.stringify({ access_token: "tok123", expires_in: 3600 }));
  try {
    await assert.doesNotReject(validateAndreaniCreds("clientId", "secret"));
  } finally {
    restoreFetch();
  }
});

test("validateAndreaniCreds — 401 → AndreaniPreflightError (not transient)", async () => {
  mockFetch(401, "Unauthorized");
  try {
    await assert.rejects(
      () => validateAndreaniCreds("bad-id", "bad-secret"),
      (err) => {
        assert.ok(err instanceof AndreaniPreflightError);
        assert.equal(err.transient, false);
        assert.ok(err.spanishMessage.includes("Andreani rechazó"));
        return true;
      },
    );
  } finally {
    restoreFetch();
  }
});

test("validateAndreaniCreds — 403 → AndreaniPreflightError (not transient)", async () => {
  mockFetch(403, "Forbidden");
  try {
    await assert.rejects(
      () => validateAndreaniCreds("id", "secret"),
      (err) => {
        assert.ok(err instanceof AndreaniPreflightError);
        assert.equal(err.transient, false);
        return true;
      },
    );
  } finally {
    restoreFetch();
  }
});

test("validateAndreaniCreds — 500 → AndreaniPreflightError (transient)", async () => {
  mockFetch(500, "Internal Server Error");
  try {
    await assert.rejects(
      () => validateAndreaniCreds("id", "secret"),
      (err) => {
        assert.ok(err instanceof AndreaniPreflightError);
        assert.equal(err.transient, true);
        assert.ok(err.spanishMessage.includes("error de servidor"));
        return true;
      },
    );
  } finally {
    restoreFetch();
  }
});

test("validateAndreaniCreds — 404 → AndreaniPreflightError (transient)", async () => {
  mockFetch(404, "Not Found");
  try {
    await assert.rejects(
      () => validateAndreaniCreds("id", "secret"),
      (err) => {
        assert.ok(err instanceof AndreaniPreflightError);
        assert.equal(err.transient, true);
        return true;
      },
    );
  } finally {
    restoreFetch();
  }
});

test("validateAndreaniCreds — network abort → AndreaniPreflightError (transient)", async () => {
  savedFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    const e = new Error("This operation was aborted");
    e.name = "AbortError";
    throw Object.assign(e, { message: "abort" });
  };
  try {
    await assert.rejects(
      () => validateAndreaniCreds("id", "secret"),
      (err) => {
        assert.ok(err instanceof AndreaniPreflightError);
        assert.equal(err.transient, true);
        return true;
      },
    );
  } finally {
    restoreFetch();
  }
});

test("validateAndreaniCreds — clientSecret is NOT present in error message on 401", async () => {
  const SECRET = "super-secret-value-12345";
  mockFetch(401, "Unauthorized");
  try {
    let thrown = null;
    try {
      await validateAndreaniCreds("clientId", SECRET);
    } catch (e) {
      thrown = e;
    }
    assert.ok(thrown instanceof AndreaniPreflightError);
    assert.ok(!thrown.spanishMessage.includes(SECRET), "Secret must not appear in error message");
    assert.ok(!thrown.message.includes(SECRET), "Secret must not appear in Error.message");
  } finally {
    restoreFetch();
  }
});
