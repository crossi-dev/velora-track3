const assert = require("node:assert/strict");
const test = require("node:test");
const crypto = require("crypto");

const {
  signAgentAssertion,
  verifyAgentAssertion,
  clearKeyPairCache,
} = require("../../src/lib/agent-identity.ts");

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Generate a throw-away Ed25519 keypair and inject it as an env var.
 *  Async so callers can `await verifyAgentAssertion(...)` inside the callback
 *  without the finally block clearing the env before the async work completes. */
async function withKeyEnv(envVar, fn) {
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  const original = process.env[envVar];
  process.env[envVar] = pem;
  try {
    return await fn(pem);
  } finally {
    if (original === undefined) {
      delete process.env[envVar];
    } else {
      process.env[envVar] = original;
    }
  }
}

function decodeBase64url(s) {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from((s + pad).replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function decodeJwtHeader(jwt) {
  return JSON.parse(decodeBase64url(jwt.split(".")[0]).toString("utf8"));
}

function decodeJwtPayload(jwt) {
  return JSON.parse(decodeBase64url(jwt.split(".")[1]).toString("utf8"));
}

// ── signAgentAssertion ────────────────────────────────────────────────────────

test("signAgentAssertion: returns null when issuer key is not configured", () => {
  const envVar = "AGENT_IDENTITY_KEY_SUPERVISOR";
  const original = process.env[envVar];
  delete process.env[envVar];
  try {
    assert.equal(signAgentAssertion("supervisor", "payments"), null);
  } finally {
    if (original !== undefined) process.env[envVar] = original;
  }
});

test("signAgentAssertion: returns a 3-part JWT string when key is configured", () => {
  withKeyEnv("AGENT_IDENTITY_KEY_SUPERVISOR", () => {
    const token = signAgentAssertion("supervisor", "payments");
    assert.ok(token, "expected a token");
    assert.equal(token.split(".").length, 3);
  });
});

test("signAgentAssertion: JWT header has alg=EdDSA", () => {
  withKeyEnv("AGENT_IDENTITY_KEY_SUPERVISOR", () => {
    const token = signAgentAssertion("supervisor", "payments");
    assert.ok(token);
    const header = decodeJwtHeader(token);
    assert.equal(header.alg, "EdDSA");
  });
});

test("signAgentAssertion: JWT payload contains jti (unique id)", () => {
  withKeyEnv("AGENT_IDENTITY_KEY_SUPERVISOR", () => {
    const t1 = signAgentAssertion("supervisor", "payments");
    const t2 = signAgentAssertion("supervisor", "payments");
    assert.ok(t1 && t2);
    const p1 = decodeJwtPayload(t1);
    const p2 = decodeJwtPayload(t2);
    assert.ok(typeof p1.jti === "string" && p1.jti.length > 0, "jti must be present");
    assert.notEqual(p1.jti, p2.jti, "each token must have a unique jti");
  });
});

// ── verifyAgentAssertion ──────────────────────────────────────────────────────

test("verifyAgentAssertion: rejects null token (fail-closed)", async () => {
  await withKeyEnv("AGENT_IDENTITY_KEY_SUPERVISOR", async () => {
    assert.equal(await verifyAgentAssertion(null, "supervisor", "payments"), false);
  });
});

test("verifyAgentAssertion: rejects missing token when key also absent (CRITICAL, fail-closed)", async () => {
  const envVar = "AGENT_IDENTITY_KEY_SUPERVISOR";
  const original = process.env[envVar];
  delete process.env[envVar];
  try {
    assert.equal(await verifyAgentAssertion(null, "supervisor", "payments"), false);
  } finally {
    if (original !== undefined) process.env[envVar] = original;
  }
});

test("verifyAgentAssertion: rejects JWT with alg != EdDSA (algorithm confusion defense)", async () => {
  await withKeyEnv("AGENT_IDENTITY_KEY_SUPERVISOR", async (pem) => {
    // Manually craft a JWT with alg=RS256 in the header
    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" }))
      .toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
    const now = Math.floor(Date.now() / 1000);
    const payloadObj = { iss: "supervisor", sub: "supervisor", aud: "payments", iat: now, exp: now + 60 };
    const payload = Buffer.from(JSON.stringify(payloadObj))
      .toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
    // Sign with real key so the signature itself would be valid — alg check must fire first
    const privateKey = crypto.createPrivateKey({ key: pem, format: "pem" });
    const message = Buffer.from(`${header}.${payload}`);
    const sig = crypto.sign(null, message, privateKey)
      .toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
    const token = `${header}.${payload}.${sig}`;
    assert.equal(await verifyAgentAssertion(token, "supervisor", "payments"), false);
  });
});

test("verifyAgentAssertion: accepts a valid EdDSA token signed by the issuer key", async () => {
  await withKeyEnv("AGENT_IDENTITY_KEY_SUPERVISOR", async () => {
    await withKeyEnv("AGENT_IDENTITY_KEY_PAYMENTS", async () => {
      const token = signAgentAssertion("supervisor", "payments");
      assert.ok(token);
      assert.equal(await verifyAgentAssertion(token, "supervisor", "payments"), true);
    });
  });
});

test("verifyAgentAssertion: rejects token with wrong iss", async () => {
  await withKeyEnv("AGENT_IDENTITY_KEY_FISCAL", async () => {
    await withKeyEnv("AGENT_IDENTITY_KEY_PAYMENTS", async () => {
      // Sign as fiscal but claim iss=supervisor
      const token = signAgentAssertion("fiscal", "payments");
      assert.ok(token);
      assert.equal(await verifyAgentAssertion(token, "supervisor", "payments"), false);
    });
  });
});

test("verifyAgentAssertion: rejects token with wrong aud", async () => {
  await withKeyEnv("AGENT_IDENTITY_KEY_SUPERVISOR", async () => {
    await withKeyEnv("AGENT_IDENTITY_KEY_FISCAL", async () => {
      const token = signAgentAssertion("supervisor", "fiscal");
      assert.ok(token);
      // Token addressed to fiscal, verified against payments
      assert.equal(await verifyAgentAssertion(token, "supervisor", "payments"), false);
    });
  });
});

test("verifyAgentAssertion: rejects expired token", async () => {
  await withKeyEnv("AGENT_IDENTITY_KEY_SUPERVISOR", async (pem) => {
    await withKeyEnv("AGENT_IDENTITY_KEY_PAYMENTS", async () => {
      const base64url = (s) =>
        Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
      const header = base64url(JSON.stringify({ alg: "EdDSA", typ: "JWT", kid: "velora-supervisor-v1" }));
      const past = Math.floor(Date.now() / 1000) - 120;
      const payloadObj = { iss: "supervisor", sub: "supervisor", aud: "payments", iat: past - 60, exp: past };
      const payload = base64url(JSON.stringify(payloadObj));
      const privateKey = crypto.createPrivateKey({ key: pem, format: "pem" });
      const sig = crypto.sign(null, Buffer.from(`${header}.${payload}`), privateKey)
        .toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
      const token = `${header}.${payload}.${sig}`;
      assert.equal(await verifyAgentAssertion(token, "supervisor", "payments"), false);
    });
  });
});

test("verifyAgentAssertion: rejects when issuer key is absent at verify time (fail-closed)", async () => {
  // We have a valid token but the verify-time key is gone
  let token;
  await withKeyEnv("AGENT_IDENTITY_KEY_SUPERVISOR", async () => {
    await withKeyEnv("AGENT_IDENTITY_KEY_PAYMENTS", async () => {
      token = signAgentAssertion("supervisor", "payments");
    });
  });
  // Both keys are now unset — verify must fail
  assert.ok(token);
  const envVar = "AGENT_IDENTITY_KEY_SUPERVISOR";
  const original = process.env[envVar];
  delete process.env[envVar];
  // Invalidate the in-process key cache so verify cannot reuse the cached
  // public key from the earlier sign() call inside withKeyEnv.
  clearKeyPairCache();
  try {
    assert.equal(await verifyAgentAssertion(token, "supervisor", "payments"), false);
  } finally {
    if (original !== undefined) process.env[envVar] = original;
  }
});
