// AES-256-GCM envelope encryption for MpConnection tokens.
//
// Key source: versioned env vars.
//   v1: MP_TOKEN_ENCRYPTION_KEY          (backward-compat, always required)
//   v2: MP_TOKEN_ENCRYPTION_KEY_V2
//   vN: MP_TOKEN_ENCRYPTION_KEY_V<N>
// Each must be a 32-byte buffer encoded as base64 (44-char string). Generate with:
//   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
// Store in Google Secret Manager, mount to Cloud Run as env var.
//
// Active version: MP_TOKEN_KEY_CURRENT_VERSION env var (defaults to "1").
//
// Ciphertext wire format (current): "v<N>:<iv_b64>:<tag_b64>:<ct_b64>"
//   N   — key version integer (1, 2, ...)
//   iv  — 12-byte random nonce (96-bit, GCM standard)
//   tag — 16-byte authentication tag
//   ct  — ciphertext (same byte length as plaintext)
//
// Legacy ciphertext format (no version prefix): "<iv_b64>:<tag_b64>:<ct_b64>"
//   Treated as v1 for backward-compatibility.
//
// Rotation plan: after adding MP_TOKEN_ENCRYPTION_KEY_V2 and setting
// MP_TOKEN_KEY_CURRENT_VERSION=2, new tokens are encrypted with v2. Old v1
// tokens keep decrypting as long as MP_TOKEN_ENCRYPTION_KEY stays mounted.
// Run scripts/migrate-mp-rekey.mjs to re-encrypt existing rows with v2
// (not blocking — v1 keeps working until that migration completes).
//
// Decryption authenticates before returning plaintext; any tampering throws.

import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;

// ─── Key loading ────────────────────────────────────────────────────────────

function envVarForVersion(version: number): string {
  return version === 1 ? "MP_TOKEN_ENCRYPTION_KEY" : `MP_TOKEN_ENCRYPTION_KEY_V${version}`;
}

function loadKey(version: number): Buffer {
  const varName = envVarForVersion(version);
  const raw = process.env[varName];
  if (!raw) {
    throw new Error(
      `${varName} is not set. ` +
        "Add a 32-byte base64-encoded key to Secret Manager and mount it as an env var.",
    );
  }
  const key = Buffer.from(raw, "base64");
  if (key.byteLength !== 32) {
    throw new Error(
      `${varName} must decode to exactly 32 bytes (got ${key.byteLength}). ` +
        "Re-generate with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"",
    );
  }
  return key;
}

function currentVersion(): number {
  const raw = process.env.MP_TOKEN_KEY_CURRENT_VERSION;
  if (!raw) return 1;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) {
    throw new Error(
      `MP_TOKEN_KEY_CURRENT_VERSION must be a positive integer (got "${raw}").`,
    );
  }
  return n;
}

// ─── Encrypt ────────────────────────────────────────────────────────────────

export function encrypt(plaintext: string): string {
  const version = currentVersion();
  const key = loadKey(version);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    `v${version}`,
    iv.toString("base64"),
    tag.toString("base64"),
    ct.toString("base64"),
  ].join(":");
}

// ─── Decrypt ────────────────────────────────────────────────────────────────

export function decrypt(ciphertext: string): string {
  const parts = ciphertext.split(":");

  let version: number;
  let ivB64: string;
  let tagB64: string;
  let ctB64: string;

  if (parts.length === 4 && /^v\d+$/.test(parts[0])) {
    // Current versioned format: "v<N>:<iv>:<tag>:<ct>"
    version = parseInt(parts[0].slice(1), 10);
    [, ivB64, tagB64, ctB64] = parts;
  } else if (parts.length === 3) {
    // Legacy format (no version prefix): "<iv>:<tag>:<ct>" — treat as v1
    version = 1;
    [ivB64, tagB64, ctB64] = parts;
  } else {
    throw new Error(
      "Invalid ciphertext format. Expected 'v<N>:<iv>:<tag>:<ct>' or legacy '<iv>:<tag>:<ct>'.",
    );
  }

  const key = loadKey(version);
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const ct = Buffer.from(ctB64, "base64");

  if (iv.byteLength !== IV_BYTES) {
    throw new Error(`IV must be ${IV_BYTES} bytes.`);
  }
  if (tag.byteLength !== TAG_BYTES) {
    throw new Error(`Auth tag must be ${TAG_BYTES} bytes.`);
  }

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}
