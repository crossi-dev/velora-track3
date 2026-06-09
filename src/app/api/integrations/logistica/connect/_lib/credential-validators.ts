// credential-validators.ts — per-provider credential shape validators.
// Called before preflight to reject obviously incomplete payloads early.

export interface ValidationResult {
  ok: boolean;
  error?: string;
}

function checkRequired(
  creds: Record<string, unknown>,
  required: Array<[string, string]>,
  providerLabel: string,
): ValidationResult {
  const missing = required.filter(([key]) => {
    const v = creds[key];
    return typeof v !== "string" || v.trim() === "";
  });
  if (missing.length > 0) {
    return {
      ok: false,
      error: `Faltan los siguientes campos de credenciales ${providerLabel}: ${missing.map(([, label]) => label).join(", ")}.`,
    };
  }
  return { ok: true };
}

export function validateAndreaniCredentials(creds: Record<string, unknown>): ValidationResult {
  return checkRequired(creds, [
    ["clientId",          "clientId"],
    ["clientSecret",      "clientSecret"],
    ["contratoDomicilio", "contratoDomicilio"],
    ["contratoSucursal",  "contratoSucursal"],
    ["contratoExpress",   "contratoExpress"],
  ], "Andreani");
}

export function validateOcaCredentials(creds: Record<string, unknown>): ValidationResult {
  return checkRequired(creds, [
    ["usuario",   "usuario"],
    ["password",  "password"],
    ["cuit",      "cuit"],
    ["operativa", "operativa"],
    ["nroCuenta", "nroCuenta"],
  ], "OCA");
}

export function validateCorreoCredentials(creds: Record<string, unknown>): ValidationResult {
  return checkRequired(creds, [
    ["username", "username"],
    ["password", "password"],
  ], "Correo Argentino");
}

export type CourierProvider = "andreani" | "oca" | "correo";
export const VALID_PROVIDERS: readonly CourierProvider[] = ["andreani", "oca", "correo"];

export function validateCredentials(
  provider: CourierProvider,
  creds: Record<string, unknown>,
): ValidationResult {
  if (provider === "andreani") return validateAndreaniCredentials(creds);
  if (provider === "oca")      return validateOcaCredentials(creds);
  return validateCorreoCredentials(creds);
}
