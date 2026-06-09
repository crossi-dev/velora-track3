// courier-credential-loader.ts — loads and decrypts per-business CourierCredential rows.
//
// Security contract:
//   - Decrypted credentials MUST NOT be logged, returned to clients, or stored in memory
//     beyond the scope of a single request.
//   - The only callers should be courier API adapters (andreani-api-client.ts,
//     oca-adapter.ts, correo-adapter.ts). Never expose this module to route handlers.
//
// Fallback semantics (transitional):
//   If no CourierCredential exists for (businessId, provider) we return null so callers
//   can fall back to platform-wide env vars. Once all clients have connected their own
//   accounts the fallback will be deprecated.

import { prisma } from "@/lib/prisma";
import { decrypt } from "@/infrastructure/crypto/mp-token-cipher";

export type CourierProvider = "andreani" | "oca" | "correo";

// ── Andreani-specific credential shape ──────────────────────────────────────

export interface AndreaniCredentials {
  clientId: string;
  clientSecret: string;
  contratoDomicilio: string;
  contratoSucursal: string;
  contratoExpress: string;
  /** "production" | "sandbox" — which Andreani endpoint this credential targets. */
  environment: "production" | "sandbox";
}

// ── Generic loader ───────────────────────────────────────────────────────────

interface RawCredentialRow {
  creds: Record<string, unknown>;
  environment: string;
}

/**
 * Load and decrypt credentials for a given (businessId, provider).
 * Returns null when no credential row exists (caller should use env-var fallback).
 * Throws if a row exists but decryption fails (tampered or wrong key).
 */
async function loadCourierCredentials(
  businessId: string,
  provider: CourierProvider,
): Promise<RawCredentialRow | null> {
  const row = await prisma.courierCredential.findUnique({
    where: { businessId_provider: { businessId, provider } },
    select: { encryptedCredentials: true, environment: true },
  });

  if (!row) return null;

  // Decrypt throws on tag-mismatch (tampered ciphertext) — propagate to caller.
  const plaintext = decrypt(row.encryptedCredentials);
  return {
    creds: JSON.parse(plaintext) as Record<string, unknown>,
    environment: row.environment,
  };
}

// ── Andreani-specific loader ─────────────────────────────────────────────────

/**
 * Load per-business Andreani credentials.
 * Returns null when not configured (caller falls back to env vars).
 *
 * Validates that all required fields are present and non-empty before returning.
 * An incomplete credential (e.g. migrated manually without all fields) is treated
 * as absent to avoid partial-credential API failures.
 */
export async function loadAndreaniCredentials(
  businessId: string,
): Promise<AndreaniCredentials | null> {
  const raw = await loadCourierCredentials(businessId, "andreani");
  if (!raw) return null;

  const c = raw.creds;
  const cid       = typeof c.clientId          === "string" ? c.clientId.trim()          : "";
  const csec      = typeof c.clientSecret      === "string" ? c.clientSecret.trim()      : "";
  const domicilio = typeof c.contratoDomicilio  === "string" ? c.contratoDomicilio.trim() : "";
  const sucursal  = typeof c.contratoSucursal   === "string" ? c.contratoSucursal.trim()  : "";
  const express   = typeof c.contratoExpress    === "string" ? c.contratoExpress.trim()   : "";

  // Treat incomplete credentials as absent — all five fields are required for Andreani.
  if (!cid || !csec || !domicilio || !sucursal || !express) return null;

  const env = raw.environment === "sandbox" ? "sandbox" as const : "production" as const;
  return {
    clientId: cid, clientSecret: csec,
    contratoDomicilio: domicilio, contratoSucursal: sucursal, contratoExpress: express,
    environment: env,
  };
}

// ── OCA-specific credential shape ────────────────────────────────────────────

export interface OcaCredentials {
  /** OCA e-Pak account username. */
  usuario: string;
  /** OCA e-Pak account password. NEVER log or return. */
  password: string;
  /** CUIT of the business (e.g. "20-12345678-9") — required for Tarifar_Envio_Corporativo. */
  cuit: string;
  /** OCA commercial contract code (operativa). */
  operativa: string;
  /** OCA account number (nroCuenta) used in shipment XML. */
  nroCuenta: string;
}

// ── OCA-specific loader ──────────────────────────────────────────────────────

/**
 * Load per-business OCA credentials.
 * Returns null when not configured so the OCA adapter degrades gracefully
 * (compare_rates fan-out simply omits OCA results for this business).
 *
 * All five fields are required. An incomplete credential row is treated as
 * absent to prevent partial-credential API failures.
 */
export async function loadOcaCredentials(
  businessId: string,
): Promise<OcaCredentials | null> {
  const raw = await loadCourierCredentials(businessId, "oca");
  if (!raw) return null;

  const c = raw.creds;
  const usuario   = typeof c.usuario   === "string" ? c.usuario.trim()   : "";
  const password  = typeof c.password  === "string" ? c.password.trim()  : "";
  const cuit      = typeof c.cuit      === "string" ? c.cuit.trim()      : "";
  const operativa = typeof c.operativa === "string" ? c.operativa.trim() : "";
  const nroCuenta = typeof c.nroCuenta === "string" ? c.nroCuenta.trim() : "";

  // All five fields required — incomplete row treated as absent.
  if (!usuario || !password || !cuit || !operativa || !nroCuenta) return null;

  return { usuario, password, cuit, operativa, nroCuenta };
}

// ── Correo Argentino credential shape ────────────────────────────────────────

export interface CorreoCredentials {
  /** MiCorreo registered username (typically the business email). */
  username: string;
  /** MiCorreo password. NEVER log or return. */
  password: string;
  /**
   * customerId returned by POST /Users/validate during preflight.
   * Required for POST /Rates. Stored so we never call validate at quote time.
   */
  customerId: string;
}

// ── Correo-specific loader ────────────────────────────────────────────────────

/**
 * Load per-business Correo Argentino credentials.
 * Returns null when not configured so the Correo adapter degrades gracefully
 * (compare_rates fan-out simply omits Correo for this business).
 *
 * All three fields are required. An incomplete credential row is treated as
 * absent to prevent partial-credential API failures.
 */
export async function loadCorreoCredentials(
  businessId: string,
): Promise<CorreoCredentials | null> {
  const raw = await loadCourierCredentials(businessId, "correo");
  if (!raw) return null;

  const c          = raw.creds;
  const username   = typeof c.username   === "string" ? c.username.trim()   : "";
  const password   = typeof c.password   === "string" ? c.password.trim()   : "";
  const customerId = typeof c.customerId === "string" ? c.customerId.trim() : "";

  // All three fields required — incomplete row treated as absent.
  if (!username || !password || !customerId) return null;

  return { username, password, customerId };
}
