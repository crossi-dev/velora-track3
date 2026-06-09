// wsaa-preflight.ts — Validates a PKCS#12 buffer against AFIP WSAA
// BEFORE the cert is uploaded to GCS or persisted in the DB.
//
// Supports both production and homologación environments:
//   production → https://wsaa.afip.gov.ar/ws/services/LoginCms
//   homo       → https://wsaahomo.afip.gov.ar/ws/services/LoginCms
//
// This is the ONLY place the raw buffer is used for network I/O.
// The buffer never touches disk. The passphrase is never logged or returned.
//
// On success: returns void.
// On expected AFIP rejection: throws WsaaPreflightError with a Spanish message.
// On network timeout / unexpected failure: throws WsaaPreflightError with a
//   "try again" message so the caller can return a 422 without persisting anything.
//
// Cert extraction uses node-forge (same as cert-loader.ts) so preflight and
// loader validate identically — a cert that passes preflight is guaranteed to
// pass loader at emit time.

import { createPrivateKey } from "node:crypto";
import { buildCms } from "@/app/api/agents/fiscal/jsonrpc/_lib/arca-real/arca-cms-builder";
import {
  soapPost,
  extractTag,
  buildSoapEnvelope,
} from "@/app/api/agents/fiscal/jsonrpc/_lib/arca-real/soap-helpers";
import { extractFirstCertPemFromP12 } from "@/app/api/agents/fiscal/jsonrpc/_lib/arca-real/cert-loader";
import { buildLoginTicketRequestXml } from "@/app/api/agents/fiscal/jsonrpc/_lib/arca-real/wsaa";
import type { KeyObject } from "node:crypto";

const WSAA_ENDPOINTS: Record<"production" | "homo", string> = {
  production: "https://wsaa.afip.gov.ar/ws/services/LoginCms",
  homo: "https://wsaahomo.afip.gov.ar/ws/services/LoginCms",
};

// ── Typed error ───────────────────────────────────────────────────────────────

export class WsaaPreflightError extends Error {
  /** Human-readable Spanish message — safe to surface to the owner. */
  readonly spanishMessage: string;
  /** Whether the failure is transient (network/timeout) vs credential-related. */
  readonly transient: boolean;

  constructor(spanishMessage: string, transient = false) {
    super(spanishMessage);
    this.name = "WsaaPreflightError";
    this.spanishMessage = spanishMessage;
    this.transient = transient;
  }
}

// ── Internal cert parsing from buffer ────────────────────────────────────────

interface ParsedCertBuffer {
  privateKey: KeyObject;
  certPem: string;
}

/**
 * Parses a PKCS#12 buffer using the supplied passphrase.
 * Throws WsaaPreflightError if parsing fails (wrong passphrase or bad format).
 * The passphrase is NOT included in any thrown error message.
 *
 * Uses the same cert-loader extractFirstCertPemFromP12 (node-forge) as the
 * real emission path, guaranteeing identical validation at preflight and emit time.
 */
function parseCertBuffer(p12Buffer: Buffer, passphrase: string): ParsedCertBuffer {
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey({
      key: p12Buffer,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- @types/node doesn't expose pkcs12 format yet; valid at runtime in Node 22+
      format: "pkcs12" as any,
      passphrase,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- opts type narrower than runtime API; pkcs12 is valid at runtime
    } as any);
  } catch {
    // DO NOT include passphrase or internal error details in the message.
    throw new WsaaPreflightError(
      "No se pudo abrir el certificado con la contraseña proporcionada. " +
        "Verificá que el .p12 sea el de producción y que la contraseña sea correcta.",
    );
  }

  let certPem: string;
  try {
    // Delegate to cert-loader's node-forge implementation — single source of truth
    // for cert extraction so preflight and emission use identical parsing logic.
    certPem = extractFirstCertPemFromP12(p12Buffer, passphrase);
  } catch {
    throw new WsaaPreflightError(
      "El certificado no contiene un certificado X.509 válido. " +
        "Verificá que el .p12 fue exportado correctamente desde el portal de ARCA.",
    );
  }

  return { privateKey, certPem };
}

// ── WSAA response validator ───────────────────────────────────────────────────

export function validateWsaaResponse(xml: string, cuit: string): void {
  // A SOAP Fault means AFIP explicitly rejected us.
  if (xml.includes("<faultcode>") || xml.includes("<SOAP-ENV:Fault>")) {
    const faultString = extractTag(xml, "faultstring") ?? "";
    // Classify common AFIP rejection reasons for better Spanish messages.
    const lower = faultString.toLowerCase();
    if (lower.includes("cuit") || lower.includes("contribuyente")) {
      throw new WsaaPreflightError(
        `AFIP no reconoció el CUIT ${cuit} asociado a este certificado. ` +
          "Verificá que el CUIT configurado en Velora coincide con el titular del certificado.",
      );
    }
    if (lower.includes("expired") || lower.includes("vencid") || lower.includes("expirado")) {
      throw new WsaaPreflightError(
        "El certificado está vencido. Obtené uno nuevo desde el portal de ARCA " +
          "(Administrador de Relaciones → Certificados Digitales).",
      );
    }
    if (lower.includes("revoked") || lower.includes("revocad")) {
      throw new WsaaPreflightError(
        "El certificado fue revocado por AFIP. Generá un nuevo certificado desde el portal de ARCA.",
      );
    }
    // Generic AFIP rejection.
    throw new WsaaPreflightError(
      "AFIP rechazó el certificado. Verificá que el .p12 sea el de producción y que la " +
        "contraseña sea correcta. Detalle: " +
        faultString.slice(0, 120),
    );
  }

  // Check that we got a token back.
  const token = extractTag(xml, "token");
  if (!token) {
    throw new WsaaPreflightError(
      "AFIP respondió pero no emitió un token de acceso. Intentá de nuevo.",
      true, // transient
    );
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Validates the given .p12 buffer + passphrase + CUIT against AFIP WSAA.
 * Routes to the production or homologación endpoint based on `environment`.
 * Returns void on success. Throws WsaaPreflightError on failure.
 *
 * SECURITY: The passphrase is never logged, returned, or included in errors.
 * The buffer is kept in memory only for the duration of this call.
 */
export async function validateCertAgainstWsaa(
  p12Buffer: Buffer,
  passphrase: string,
  cuit: string,
  environment: "production" | "homo" = "production",
): Promise<void> {
  const wsaaUrl = WSAA_ENDPOINTS[environment];

  // Step 1: parse the cert from the buffer.
  const { privateKey, certPem } = parseCertBuffer(p12Buffer, passphrase);

  // Step 2: build and sign the LoginTicketRequest.
  // buildLoginTicketRequestXml is imported from wsaa.ts — single source of truth,
  // so any AFIP format change only needs to be made in one place.
  const ltrXml = buildLoginTicketRequestXml(cuit);
  let cms: string;
  try {
    cms = buildCms(Buffer.from(ltrXml, "utf-8"), privateKey, certPem);
  } catch {
    throw new WsaaPreflightError(
      "No se pudo firmar el request para AFIP. El certificado puede estar dañado o incompleto.",
    );
  }

  // Step 3: POST to WSAA. The 15 s timeout is enforced inside soapPost (soap-helpers.ts).
  const soapBody = buildSoapEnvelope(
    "http://wsaa.view.sua.afip.gov.ar",
    `<ar:loginCms><ar:in0>${cms}</ar:in0></ar:loginCms>`,
  );

  let responseXml: string;
  try {
    responseXml = await soapPost(wsaaUrl, "loginCms", soapBody);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Timeout") || msg.includes("abort") || msg.includes("ECONNRESET")) {
      throw new WsaaPreflightError(
        "No pudimos verificar el certificado con AFIP en este momento (tiempo de espera agotado). " +
          "Probá de nuevo en unos segundos.",
        true,
      );
    }
    throw new WsaaPreflightError(
      "No pudimos conectarnos con AFIP para verificar el certificado. Probá de nuevo.",
      true,
    );
  }

  // Step 4: validate the response.
  validateWsaaResponse(responseXml, cuit);
}
