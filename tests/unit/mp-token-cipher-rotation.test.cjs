"use strict";
// PL-3 — Versioned MP token ciphertext for key rotation support.
// Tests the versioned encrypt/decrypt contract in mp-token-cipher.ts.

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");

const MODULE_PATH = "../../src/infrastructure/crypto/mp-token-cipher.ts";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function randomKey() {
  return crypto.randomBytes(32).toString("base64");
}

function loadFresh() {
  const resolved = require.resolve(MODULE_PATH);
  delete require.cache[resolved];
  return require(MODULE_PATH);
}

function withEnv(env, fn) {
  const ALL_KEYS = [
    "MP_TOKEN_ENCRYPTION_KEY",
    "MP_TOKEN_ENCRYPTION_KEY_V2",
    "MP_TOKEN_ENCRYPTION_KEY_V3",
    "MP_TOKEN_KEY_CURRENT_VERSION",
  ];
  const prev = Object.fromEntries(ALL_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ALL_KEYS) {
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  try {
    return fn(loadFresh());
  } finally {
    for (const k of ALL_KEYS) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

// ─── Basic v1 round-trip ─────────────────────────────────────────────────────

test("v1 round-trip: encrypt with v1 then decrypt with v1", () => {
  const key1 = randomKey();
  withEnv({ MP_TOKEN_ENCRYPTION_KEY: key1 }, ({ encrypt, decrypt }) => {
    const ct = encrypt("access_token_abc123");
    assert.ok(ct.startsWith("v1:"), `ciphertext must start with 'v1:' — got: ${ct.slice(0, 10)}`);
    assert.equal(decrypt(ct), "access_token_abc123");
  });
});

// ─── Versioned format prefix ─────────────────────────────────────────────────

test("encrypt with CURRENT_VERSION=2 produces v2: prefix", () => {
  const key1 = randomKey();
  const key2 = randomKey();
  withEnv({
    MP_TOKEN_ENCRYPTION_KEY: key1,
    MP_TOKEN_ENCRYPTION_KEY_V2: key2,
    MP_TOKEN_KEY_CURRENT_VERSION: "2",
  }, ({ encrypt }) => {
    const ct = encrypt("token_xyz");
    assert.ok(ct.startsWith("v2:"), `expected v2: prefix, got: ${ct.slice(0, 10)}`);
  });
});

// ─── Backward-compat: v1 still decryptable after rotating to v2 ──────────────

test("backward-compat: v1 ciphertext decrypts after CURRENT_VERSION set to 2", () => {
  const key1 = randomKey();
  const key2 = randomKey();

  // Step 1: encrypt with v1 (old state)
  let oldCiphertext;
  withEnv({ MP_TOKEN_ENCRYPTION_KEY: key1 }, ({ encrypt }) => {
    oldCiphertext = encrypt("refresh_token_old");
  });

  assert.ok(oldCiphertext.startsWith("v1:"));

  // Step 2: now v2 is active but v1 key is still mounted — decrypt old ct
  withEnv({
    MP_TOKEN_ENCRYPTION_KEY: key1,
    MP_TOKEN_ENCRYPTION_KEY_V2: key2,
    MP_TOKEN_KEY_CURRENT_VERSION: "2",
  }, ({ decrypt }) => {
    assert.equal(decrypt(oldCiphertext), "refresh_token_old");
  });
});

// ─── Legacy format (no version prefix) decrypts as v1 ───────────────────────

test("legacy ciphertext (no v prefix, 3 parts) decrypts as v1", () => {
  const key1 = randomKey();

  // Build a legacy ciphertext manually using Node crypto (same algorithm,
  // same iv/tag/ct structure but without the v1: prefix).
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", Buffer.from(key1, "base64"), iv);
  const ct = Buffer.concat([cipher.update("legacy_plaintext", "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const legacyCiphertext = [iv.toString("base64"), tag.toString("base64"), ct.toString("base64")].join(":");

  // Must NOT start with 'v'
  assert.ok(!legacyCiphertext.startsWith("v"), "legacy format must not have v prefix");

  withEnv({ MP_TOKEN_ENCRYPTION_KEY: key1 }, ({ decrypt }) => {
    assert.equal(decrypt(legacyCiphertext), "legacy_plaintext");
  });
});

// ─── Wrong key throws (tamper/rotation mismatch) ─────────────────────────────

test("decrypt with wrong key throws (GCM auth tag mismatch)", () => {
  const key1 = randomKey();
  const key2 = randomKey();

  let ct;
  withEnv({ MP_TOKEN_ENCRYPTION_KEY: key1 }, ({ encrypt }) => {
    ct = encrypt("secret_data");
  });

  // Try to decrypt the v1 ciphertext using a different key mounted at v1
  assert.throws(() => {
    withEnv({ MP_TOKEN_ENCRYPTION_KEY: key2 }, ({ decrypt }) => {
      decrypt(ct);
    });
  }, "decrypting with wrong key must throw");
});

// ─── Missing key throws a descriptive error ──────────────────────────────────

test("decrypt v2 ciphertext without V2 key throws descriptive error", () => {
  const key1 = randomKey();
  const key2 = randomKey();

  let ct;
  withEnv({
    MP_TOKEN_ENCRYPTION_KEY: key1,
    MP_TOKEN_ENCRYPTION_KEY_V2: key2,
    MP_TOKEN_KEY_CURRENT_VERSION: "2",
  }, ({ encrypt }) => {
    ct = encrypt("token_for_v2");
  });

  // Now decrypt without the V2 key mounted
  assert.throws(() => {
    withEnv({ MP_TOKEN_ENCRYPTION_KEY: key1 }, ({ decrypt }) => {
      decrypt(ct);
    });
  }, /MP_TOKEN_ENCRYPTION_KEY_V2 is not set/, "must mention the missing env var");
});

// ─── Invalid ciphertext format ───────────────────────────────────────────────

test("decrypt with invalid format (2 parts) throws", () => {
  const key1 = randomKey();
  withEnv({ MP_TOKEN_ENCRYPTION_KEY: key1 }, ({ decrypt }) => {
    assert.throws(() => decrypt("abc:def"), /Invalid ciphertext format/);
  });
});
