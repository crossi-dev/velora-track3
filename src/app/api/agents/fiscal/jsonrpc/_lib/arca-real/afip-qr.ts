// afip-qr.ts — AFIP RG 4291/2018 QR URL builder for electronic invoices.
//
// Spec: https://www.afip.gob.ar/fe/qr/documentos/QRespecificaciones.pdf
// URL format: https://www.afip.gob.ar/fe/qr/?p=<base64url(JSON)>
//
// All fields are mandatory per the AFIP specification unless noted.

export interface AfipQrInput {
  /** Business CUIT, 11 digits no hyphens. */
  cuit: string;
  /** Punto de venta (1–9999). */
  ptoVta: number;
  /** WSFE tipoComprobante: 1=A, 6=B, 11=C. */
  tipoCmp: number;
  /** Sequential invoice number returned by WSFE. */
  nroComp: number;
  /** Invoice date in YYYY-MM-DD format. */
  fecha: string;
  /** Total invoice amount in ARS (2 decimal places). */
  importe: number;
  /** ISO 4217 currency code: "PES" for ARS per AFIP spec. */
  moneda: string;
  /** Exchange rate (1 for ARS domestic invoices). */
  ctz: number;
  /**
   * Document type code of the recipient (tipoDocRec).
   * 80 = CUIT, 86 = CUIL, 96 = DNI, 99 = no identifica.
   */
  tipoDocRec: number;
  /**
   * Document number of the recipient (nroDocRec).
   * For consumidor final use 0.
   */
  nroDocRec: number;
  /**
   * Authorization code type: "E" = CAE (FECAESolicitar), "A" = CAEA.
   * Velora uses CAE exclusively.
   */
  tipoCodAut: "E" | "A";
  /** 14-digit CAE code returned by WSFE FECAESolicitar. */
  codAut: string;
}

/** Versión del esquema QR per AFIP spec — always 1. */
const QR_VER = 1;

/**
 * Builds the AFIP-compliant QR URL per RG 4291/2018.
 *
 * The JSON payload is serialised with numeric keys and URL-safe Base64
 * (standard Base64; AFIP spec uses `btoa`-equivalent plain Base64).
 *
 * @returns Full URL string to encode into the QR image on the invoice PDF.
 */
export function buildAfipQrUrl(input: AfipQrInput): string {
  const payload = {
    ver: QR_VER,
    fecha: input.fecha,
    cuit: Number(input.cuit),
    ptoVta: input.ptoVta,
    tipoCmp: input.tipoCmp,
    nroComp: input.nroComp,
    importe: input.importe,
    moneda: input.moneda,
    ctz: input.ctz,
    tipoDocRec: input.tipoDocRec,
    nroDocRec: input.nroDocRec,
    tipoCodAut: input.tipoCodAut,
    codAut: Number(input.codAut),
  };
  const base64 = Buffer.from(JSON.stringify(payload)).toString("base64");
  return `https://www.afip.gob.ar/fe/qr/?p=${base64}`;
}
