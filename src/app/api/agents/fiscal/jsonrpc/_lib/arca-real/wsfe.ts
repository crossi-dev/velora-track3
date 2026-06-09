// WSFE — Web Service de Facturación Electrónica v1 (AFIP/ARCA).
//
// Operations implemented:
//   FECompUltimoAutorizado — last authorized invoice number for a (cuit, ptoVta, cbteType).
//   FECAESolicitar         — authorize (emit) an invoice and get its CAE.
//
// Endpoints:
//   Homologación: https://wswhomo.afip.gov.ar/wsfev1/service.asmx
//   Producción:   https://servicios1.afip.gov.ar/wsfev1/service.asmx
//
// Authentication: every WSFE call includes the TA (token + sign) from WSAA.
// XML builders + error parsers live in wsfe-builders.ts.

import { soapPost, buildSoapEnvelope, extractTag } from "./soap-helpers";
import type { ArcaTicket, EmitInvoiceInput, EmitInvoiceResult } from "./types";
import {
  authXml,
  toAfipDate,
  buildFECAESolicitarBody,
  extractWsfeErrors,
} from "./wsfe-builders";

// ── Endpoints ─────────────────────────────────────────────────────────────────

const WSFE_HOMO = "https://wswhomo.afip.gov.ar/wsfev1/service.asmx";
const WSFE_PROD = "https://servicios1.afip.gov.ar/wsfev1/service.asmx";

const WSFE_NS = "http://ar.gov.afip.dif.FEV1/";

// ── FECompUltimoAutorizado ─────────────────────────────────────────────────────

/**
 * Returns the last authorized invoice number for a given punto de venta +
 * comprobante type.  Returns 0 if no invoice has been issued yet.
 */
export async function getLastInvoiceNumber(
  cuit: string,
  puntoVenta: number,
  tipoComprobante: number,
  ticket: ArcaTicket,
  isProduction: boolean,
): Promise<number> {
  const body = buildSoapEnvelope(
    WSFE_NS,
    `<ar:FECompUltimoAutorizado>` +
    authXml(cuit, ticket) +
    `<ar:PtoVta>${puntoVenta}</ar:PtoVta>` +
    `<ar:CbteTipo>${tipoComprobante}</ar:CbteTipo>` +
    `</ar:FECompUltimoAutorizado>`,
  );

  const endpoint = isProduction ? WSFE_PROD : WSFE_HOMO;
  const xml = await soapPost(endpoint, "FECompUltimoAutorizado", body);

  checkWsfeFault(xml);

  const nroTag = extractTag(xml, "CbteNro");
  if (!nroTag) {
    throw new Error(
      `[wsfe] FECompUltimoAutorizado: CbteNro not found in response: ${xml.slice(0, 300)}`,
    );
  }
  return parseInt(nroTag, 10) || 0;
}

// ── FECAESolicitar ────────────────────────────────────────────────────────────

/**
 * Emits an invoice via FECAESolicitar and returns the CAE + expiry + invoice number.
 */
export async function emitInvoice(
  input: EmitInvoiceInput,
  ticket: ArcaTicket,
  isProduction: boolean,
): Promise<EmitInvoiceResult> {
  const endpoint = isProduction ? WSFE_PROD : WSFE_HOMO;

  // Step 1: get the next sequential number
  const lastNum = await getLastInvoiceNumber(
    input.cuit,
    input.puntoVenta,
    input.tipoComprobante,
    ticket,
    isProduction,
  );
  const nextNum = lastNum + 1;

  // Step 2: build the FECAESolicitar request
  const today = toAfipDate(new Date());
  const body = buildFECAESolicitarBody(input, ticket, nextNum, today, WSFE_NS);
  const xml = await soapPost(endpoint, "FECAESolicitar", body);

  // Step 3: parse response
  checkWsfeFault(xml);
  return parseFECAEResponse(xml, nextNum, input);
}

// ── Response parser ───────────────────────────────────────────────────────────

function parseFECAEResponse(
  xml: string,
  cbteNro: number,
  input: EmitInvoiceInput,
): EmitInvoiceResult {
  const resultado = extractTag(xml, "Resultado");
  if (resultado !== "A") {
    const errorDetail = extractWsfeErrors(xml);
    throw new Error(
      `[wsfe] FECAESolicitar rechazado (Resultado=${resultado}). ` +
      `${errorDetail}. XML: ${xml.slice(0, 400)}`,
    );
  }

  const cae = extractTag(xml, "CAE");
  const caeFchVto = extractTag(xml, "CAEFchVto");

  if (!cae || !caeFchVto) {
    throw new Error(
      `[wsfe] CAE or CAEFchVto missing in approved response: ${xml.slice(0, 300)}`,
    );
  }

  return {
    sandbox: false,
    cae,
    vencimientoCae: caeFchVto, // YYYYMMDD
    numero: cbteNro,
    tipoComprobante: input.tipoComprobante,
    puntoVenta: input.puntoVenta,
    issuedAt: new Date().toISOString(),
  };
}

// ── Error handling ─────────────────────────────────────────────────────────────

function checkWsfeFault(xml: string): void {
  if (xml.includes("<faultcode>") || xml.includes("<faultstring>")) {
    const faultCode = extractTag(xml, "faultcode") ?? "unknown";
    const faultStr = extractTag(xml, "faultstring") ?? xml.slice(0, 200);
    throw new Error(`[wsfe] SOAP Fault ${faultCode}: ${faultStr}`);
  }
}
