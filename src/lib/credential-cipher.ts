/**
 * credential-cipher.ts
 *
 * AES-256-GCM encryption for third-party API credentials (e.g. Andreani token).
 * Key derived via HKDF from AUTH_SECRET with label "velora-credential-v1" —
 * same domain-separation pattern as employee-auth.ts (EMPLOYEE_HKDF_INFO).
 *
 * Wire format (all base64url, colon-separated):
 *   <iv>:<ciphertext>:<authTag>
 *
 * IV is 12 bytes (96 bits) — GCM recommended length.
 * Auth tag is 16 bytes (128 bits) — GCM default.
 * Key is 32 bytes (256 bits) — AES-256.
 *
 * Tampering detection: GCM auth tag verification throws on any bit flip.
 */

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "crypto";

const HKDF_LABEL = "velora-credential-v1";
const IV_BYTES = 12;  // 96 bits — GCM standard
const KEY_BYTES = 32; // 256 bits

function deriveKey(): Buffer {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.trim().length === 0) {
    throw new Error("AUTH_SECRET is required for credential encryption");
  }
  // hkdfSync(digest, ikm, salt, info, keylen) — Node 18+
  // Same pattern as employee-auth.ts deriveEmployeeKey.
  const derived = hkdfSync("sha256", secret, Buffer.alloc(0), HKDF_LABEL, KEY_BYTES);
  return Buffer.from(derived);
}

/**
 * Encrypts a plaintext credential string with AES-256-GCM.
 * Returns a compact, opaque ciphertext string safe to store in the DB.
 *
 * Throws if AUTH_SECRET is missing or plaintext is not a non-empty string.
 */
export function encryptCredential(plaintext: string): string {
  if (typeof plaintext !== "string" || plaintext.length === 0) {
    throw new Error("encryptCredential: plaintext must be a non-empty string");
  }
  const key = deriveKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag(); // 16 bytes by default
  // Encode as base64url to keep the wire format URL-safe and compact.
  const ivB64 = iv.toString("base64url");
  const ctB64 = encrypted.toString("base64url");
  const tagB64 = authTag.toString("base64url");
  return `${ivB64}:${ctB64}:${tagB64}`;
}

/**
 * Decrypts a ciphertext string produced by encryptCredential.
 * Throws on tampering (GCM auth tag mismatch), malformed input, or missing key.
 */
export function decryptCredential(ciphertext: string): string {
  if (typeof ciphertext !== "string" || ciphertext.length === 0) {
    throw new Error("decryptCredential: ciphertext must be a non-empty string");
  }
  const parts = ciphertext.split(":");
  if (parts.length !== 3) {
    throw new Error("decryptCredential: malformed ciphertext (expected iv:ct:tag)");
  }
  const [ivB64, ctB64, tagB64] = parts as [string, string, string];
  let iv: Buffer, ct: Buffer, tag: Buffer;
  try {
    iv  = Buffer.from(ivB64,  "base64url");
    ct  = Buffer.from(ctB64,  "base64url");
    tag = Buffer.from(tagB64, "base64url");
  } catch {
    throw new Error("decryptCredential: base64url decode failed");
  }
  if (iv.length !== IV_BYTES) {
    throw new Error(`decryptCredential: IV must be ${IV_BYTES} bytes, got ${iv.length}`);
  }
  if (tag.length !== 16) {
    throw new Error(`decryptCredential: auth tag must be 16 bytes, got ${tag.length}`);
  }
  const key = deriveKey();
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  // GCM auth tag verification happens inside final() — throws on tamper.
  const decrypted = Buffer.concat([decipher.update(ct), decipher.final()]);
  return decrypted.toString("utf8");
}
