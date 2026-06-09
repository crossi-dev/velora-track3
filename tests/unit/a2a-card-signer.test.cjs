// Unit tests for a2a-card-signer: signAgentCard + verifyAgentCardSignature.
// Uses real Ed25519 keys; JWKS fetch is mocked via global.fetch override.

const assert = require("node:assert/strict");
const test = require("node:test");
const crypto = require("crypto");

const {
  signAgentCard,
  verifyAgentCardSignature,
} = require("../../src/lib/a2a-card-signer.ts");

// ── Helpers ───────────────────────────────────────────────────────────────────

function generateEd25519Pem() {
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  return privateKey.export({ type: "pkcs8", format: "pem" });
}

function withKeyEnv(envVar, pem, fn) {
  const original = process.env[envVar];
  process.env[envVar] = pem;
  try {
    return fn(pem);
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

/** Build a minimal agent card with the given baseUrl path for jwksUrl */
function makeCard(jwksUrl = "https://somosvelora.com/api/agents/payments/jwks") {
  return {
    protocolVersion: "0.3.0",
    name: "Velora Test Agent",
    description: "Test agent card",
    url: "https://somosvelora.com/api/agents/payments/jsonrpc",
    version: "1.0.0",
    skills: [],
    "x-agentIdentity": {
      kid: "velora-payments-v1",
      algorithm: "EdDSA",
      curve: "Ed25519",
      jwksUrl,
    },
  };
}

/** Build a JWKS response object from a PEM private key */
function pemToJwks(pem, kid) {
  const privateKey = crypto.createPrivateKey({ key: pem, format: "pem" });
  const publicKey = crypto.createPublicKey(privateKey);
  const jwk = publicKey.export({ format: "jwk" });
  return { keys: [{ ...jwk, kid }] };
}

/** Mock global.fetch to return a given JWKS payload once */
function mockFetch(jwks) {
  const original = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => jwks,
  });
  return () => { global.fetch = original; };
}

// ── signAgentCard ─────────────────────────────────────────────────────────────

test("signAgentCard: returns card without signature when key is not configured", () => {
  const envVar = "AGENT_IDENTITY_KEY_PAYMENTS";
  const original = process.env[envVar];
  delete process.env[envVar];
  try {
    const card = makeCard();
    const result = signAgentCard(card, "payments");
    assert.equal(result.signature, undefined, "no signature field expected");
  } finally {
    if (original !== undefined) process.env[envVar] = original;
  }
});

test("signAgentCard: adds a signature field when key is configured", () => {
  const pem = generateEd25519Pem();
  withKeyEnv("AGENT_IDENTITY_KEY_PAYMENTS", pem, () => {
    const card = makeCard();
    const result = signAgentCard(card, "payments");
    assert.ok(result.signature, "signature field should be present");
    assert.equal(typeof result.signature, "string");
  });
});

test("signAgentCard: signature is JWS Compact (3 parts separated by dots)", () => {
  const pem = generateEd25519Pem();
  withKeyEnv("AGENT_IDENTITY_KEY_PAYMENTS", pem, () => {
    const result = signAgentCard(makeCard(), "payments");
    assert.ok(result.signature);
    assert.equal(result.signature.split(".").length, 3, "must be header.payload.signature");
  });
});

test("signAgentCard: JWS header declares alg=EdDSA", () => {
  const pem = generateEd25519Pem();
  withKeyEnv("AGENT_IDENTITY_KEY_PAYMENTS", pem, () => {
    const result = signAgentCard(makeCard(), "payments");
    assert.ok(result.signature);
    const headerJson = decodeBase64url(result.signature.split(".")[0]).toString("utf8");
    const header = JSON.parse(headerJson);
    assert.equal(header.alg, "EdDSA");
  });
});

test("signAgentCard: card fields other than signature are preserved", () => {
  const pem = generateEd25519Pem();
  withKeyEnv("AGENT_IDENTITY_KEY_PAYMENTS", pem, () => {
    const card = makeCard();
    const result = signAgentCard(card, "payments");
    assert.equal(result.name, card.name);
    assert.equal(result.protocolVersion, card.protocolVersion);
    assert.deepEqual(result["x-agentIdentity"], card["x-agentIdentity"]);
  });
});

test("signAgentCard: re-signing the same card produces different signatures (non-determinism via key-pair is ok; same payload→same JWS since Ed25519 is deterministic)", () => {
  // Ed25519 IS deterministic for the same key+message — both should match
  const pem = generateEd25519Pem();
  withKeyEnv("AGENT_IDENTITY_KEY_PAYMENTS", pem, () => {
    const card = makeCard();
    const r1 = signAgentCard(card, "payments");
    const r2 = signAgentCard(card, "payments");
    assert.ok(r1.signature && r2.signature);
    // Same key, same payload → signatures must be equal (Ed25519 determinism)
    assert.equal(r1.signature, r2.signature);
  });
});

// ── verifyAgentCardSignature ──────────────────────────────────────────────────

test("verifyAgentCardSignature: returns false for card without signature field", async () => {
  const result = await verifyAgentCardSignature(makeCard());
  assert.equal(result, false);
});

test("verifyAgentCardSignature: returns false for malformed JWS (not 3 parts)", async () => {
  const card = { ...makeCard(), signature: "notavalidjws" };
  const result = await verifyAgentCardSignature(card);
  assert.equal(result, false);
});

test("verifyAgentCardSignature: returns false when alg is not EdDSA", async () => {
  const pem = generateEd25519Pem();
  // Build a JWS with alg=RS256 in header
  const b64 = (s) => Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
  const header = b64(JSON.stringify({ alg: "RS256", kid: "velora-payments-v1" }));
  const payload = b64(JSON.stringify({ name: "test" }));
  const privateKey = crypto.createPrivateKey({ key: pem, format: "pem" });
  const sig = crypto.sign(null, Buffer.from(`${header}.${payload}`), privateKey)
    .toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
  const card = { ...makeCard(), signature: `${header}.${payload}.${sig}` };
  const result = await verifyAgentCardSignature(card);
  assert.equal(result, false);
});

test("verifyAgentCardSignature: returns false when card has no x-agentIdentity.jwksUrl", async () => {
  const pem = generateEd25519Pem();
  const envVar = "AGENT_IDENTITY_KEY_PAYMENTS";
  withKeyEnv(envVar, pem, () => {
    // card without x-agentIdentity
    const card = { name: "Test", signature: "h.p.s" };
    return card;
  });
  // Sign a real card then strip jwksUrl
  withKeyEnv("AGENT_IDENTITY_KEY_PAYMENTS", pem, async () => {});
  const cardNoJwks = {
    ...makeCard(""),
    "x-agentIdentity": { kid: "velora-payments-v1", algorithm: "EdDSA", curve: "Ed25519" },
    signature: "h.p.s",
  };
  const result = await verifyAgentCardSignature(cardNoJwks);
  assert.equal(result, false);
});

test("verifyAgentCardSignature: returns false when JWKS fetch fails", async () => {
  const pem = generateEd25519Pem();
  let signed;
  withKeyEnv("AGENT_IDENTITY_KEY_PAYMENTS", pem, () => {
    signed = signAgentCard(makeCard(), "payments");
  });

  const original = global.fetch;
  global.fetch = async () => { throw new Error("network error"); };
  try {
    const result = await verifyAgentCardSignature(signed);
    assert.equal(result, false);
  } finally {
    global.fetch = original;
  }
});

test("verifyAgentCardSignature: returns false when JWKS returns wrong key (different keypair)", async () => {
  const pem = generateEd25519Pem();
  let signed;
  withKeyEnv("AGENT_IDENTITY_KEY_PAYMENTS", pem, () => {
    signed = signAgentCard(makeCard(), "payments");
  });

  // Inject a DIFFERENT key into the JWKS response
  const wrongPem = generateEd25519Pem();
  const restore = mockFetch(pemToJwks(wrongPem, "velora-payments-v1"));
  try {
    const result = await verifyAgentCardSignature(signed);
    assert.equal(result, false, "wrong key must fail verification");
  } finally {
    restore();
  }
});

test("verifyAgentCardSignature: returns true for a correctly signed card (happy path)", async () => {
  const pem = generateEd25519Pem();
  let signed;
  withKeyEnv("AGENT_IDENTITY_KEY_PAYMENTS", pem, () => {
    signed = signAgentCard(makeCard(), "payments");
  });

  const restore = mockFetch(pemToJwks(pem, "velora-payments-v1"));
  try {
    const result = await verifyAgentCardSignature(signed);
    assert.equal(result, true, "valid signature must pass verification");
  } finally {
    restore();
  }
});

test("verifyAgentCardSignature: returns false when card is tampered after signing", async () => {
  const pem = generateEd25519Pem();
  let signed;
  withKeyEnv("AGENT_IDENTITY_KEY_PAYMENTS", pem, () => {
    signed = signAgentCard(makeCard(), "payments");
  });

  // Tamper with a field
  const tampered = { ...signed, name: "Evil Agent" };

  const restore = mockFetch(pemToJwks(pem, "velora-payments-v1"));
  try {
    const result = await verifyAgentCardSignature(tampered);
    assert.equal(result, false, "tampered card must fail verification");
  } finally {
    restore();
  }
});

test("verifyAgentCardSignature: returns false when JWS has no kid in header", async () => {
  const pem = generateEd25519Pem();
  const b64 = (s) => Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
  // Build JWS with no kid
  const header = b64(JSON.stringify({ alg: "EdDSA" }));
  const card = makeCard();
  const payload = b64(JSON.stringify(card));
  const privateKey = crypto.createPrivateKey({ key: pem, format: "pem" });
  const sig = crypto.sign(null, Buffer.from(`${header}.${payload}`), privateKey)
    .toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
  const cardWithBadSig = { ...card, signature: `${header}.${payload}.${sig}` };
  const result = await verifyAgentCardSignature(cardWithBadSig);
  assert.equal(result, false, "missing kid must be rejected");
});
