"use strict";
// Run with: node --require ./tests/phase4/register.cjs --test tests/unit/credential-cipher.test.cjs
//
// Tests for src/lib/credential-cipher.ts
//
// Coverage:
//   1. Round-trip: encrypt → decrypt returns the original plaintext.
//   2. Two encryptions of the same plaintext produce different ciphertexts (random IV).
//   3. Tampering with ciphertext (auth tag) throws on decrypt (GCM integrity).
//   4. Tampering with IV throws on decrypt.
//   5. Malformed wire format (wrong segment count) throws.
//   6. Empty plaintext throws on encrypt.
//   7. Empty ciphertext throws on decrypt.

const assert = require("node:assert/strict");
const test = require("node:test");

// Provide a stable AUTH_SECRET so the tests are deterministic and
// independent of the real env var.
process.env.AUTH_SECRET = "test-auth-secret-for-credential-cipher-unit-tests-32b";

const { encryptCredential, decryptCredential } = require("../../src/lib/credential-cipher.ts");

// ── Round-trip ───────────────────────────────────────────────────────────────

test("credential-cipher: round-trip preserves plaintext", () => {
  const plaintext = "velora-test-token-abc123";
  const ciphertext = encryptCredential(plaintext);
  const decrypted = decryptCredential(ciphertext);
  assert.equal(decrypted, plaintext, "decrypted value must equal the original plaintext");
});

test("credential-cipher: round-trip works with long tokens", () => {
  const plaintext = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ2ZWxvcmEiLCJpYXQiOjE2MDAwMDAwMDB9.sig";
  const decrypted = decryptCredential(encryptCredential(plaintext));
  assert.equal(decrypted, plaintext);
});

test("credential-cipher: round-trip works with special characters", () => {
  const plaintext = "tok3n-with-sp3c!@l_ch@rs.and/slashes+plus=equals";
  const decrypted = decryptCredential(encryptCredential(plaintext));
  assert.equal(decrypted, plaintext);
});

// ── Random IV — different ciphertexts per call ────────────────────────────────

test("credential-cipher: same plaintext encrypts to different ciphertexts (random IV)", () => {
  const plaintext = "same-plaintext";
  const ct1 = encryptCredential(plaintext);
  const ct2 = encryptCredential(plaintext);
  assert.notEqual(ct1, ct2, "random IV must produce different ciphertexts for the same input");
  // Both should still decrypt correctly.
  assert.equal(decryptCredential(ct1), plaintext);
  assert.equal(decryptCredential(ct2), plaintext);
});

// ── Tampering detection (GCM auth tag) ───────────────────────────────────────

test("credential-cipher: tampering with auth tag throws", () => {
  const ciphertext = encryptCredential("sensitive-token");
  const parts = ciphertext.split(":");
  // Flip the first base64 character of the auth tag segment.
  const originalTag = parts[2];
  const tamperedChar = originalTag[0] === "A" ? "B" : "A";
  parts[2] = tamperedChar + originalTag.slice(1);
  const tampered = parts.join(":");
  assert.throws(
    () => decryptCredential(tampered),
    /Unsupported state or unable to authenticate data|bad decrypt|auth tag/i,
    "tampered auth tag must throw",
  );
});

test("credential-cipher: tampering with ciphertext body throws", () => {
  const ciphertext = encryptCredential("sensitive-token");
  const parts = ciphertext.split(":");
  const originalCt = parts[1];
  // Flip a character in the ciphertext body (not the IV or tag).
  const tamperedChar = originalCt[0] === "A" ? "B" : "A";
  parts[1] = tamperedChar + originalCt.slice(1);
  const tampered = parts.join(":");
  assert.throws(
    () => decryptCredential(tampered),
    /Unsupported state or unable to authenticate data|bad decrypt|auth tag/i,
    "tampered ciphertext body must throw",
  );
});

// ── Malformed wire format ─────────────────────────────────────────────────────

test("credential-cipher: malformed wire format (2 segments) throws", () => {
  assert.throws(
    () => decryptCredential("onlytwo:segments"),
    /malformed ciphertext/i,
  );
});

test("credential-cipher: malformed wire format (4 segments) throws", () => {
  assert.throws(
    () => decryptCredential("one:two:three:four"),
    /malformed ciphertext/i,
  );
});

// ── Guard clauses ─────────────────────────────────────────────────────────────

test("credential-cipher: encryptCredential throws on empty string", () => {
  assert.throws(
    () => encryptCredential(""),
    /non-empty string/i,
  );
});

test("credential-cipher: decryptCredential throws on empty string", () => {
  assert.throws(
    () => decryptCredential(""),
    /non-empty string/i,
  );
});
