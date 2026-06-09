// wsfe-builders.ts — SOAP XML request builder helpers for WSFE.
// Extracted from wsfe.ts to keep that file under the 300-line server limit.

import { buildSoapEnvelope, extractTag } from "./soap-helpers";
import type { ArcaTicket, EmitInvoiceInput } from "./types";

/** Escapes the 5 XML metacharacters in a string value before interpolation into SOAP XML. */
export function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Builds the `<ar:Auth>` block shared by all WSFE operations. */
export function authXml(cuit: string, ticket: ArcaTicket): string {
  return (
    `<ar:Auth>` +
    `<ar:Token>${xmlEscape(ticket.token)}</ar:Token>` +
    `<ar:Sign>${xmlEscape(ticket.sign)}</ar:Sign>` +
    `<ar:Cuit>${xmlEscape(cuit)}</ar:Cuit>` +
    `</ar:Auth>`
  );
}

/** Returns YYYYMMDD as expected by WSFE CbteFch and similar fields. */
export function toAfipDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  // Use ART (UTC-3) date
  const art = new Date(d.getTime() - 3 * 60 * 60 * 1_000);
  return (
    `${art.getUTCFullYear()}` +
    `${pad(art.getUTCMonth() + 1)}` +
    `${pad(art.getUTCDate())}`
  );
}

export function buildIvaXml(input: EmitInvoiceInput): string {
  if (!input.ivaItems.length) return "";
  const items = input.ivaItems
    .map(
      (i) =>
        `<ar:AlicIva>` +
        `<ar:Id>${i.id}</ar:Id>` +
        `<ar:BaseImp>${i.baseImponible.toFixed(2)}</ar:BaseImp>` +
        `<ar:Importe>${i.importe.toFixed(2)}</ar:Importe>` +
        `</ar:AlicIva>`,
    )
    .join("");
  return `<ar:Iva>${items}</ar:Iva>`;
}

/** NC/ND tipoComprobante codes that REQUIRE a CbtesAsoc block in WSFE. */
const NC_ND_TIPOS = new Set<number>([2, 3, 7, 8, 12, 13]);

export function buildFECAESolicitarBody(
  input: EmitInvoiceInput,
  ticket: ArcaTicket,
  cbteNro: number,
  cbteDate: string,
  wsfeNs: string,
): string {
  // Tipo A (tipoComprobante === 1) requires a valid customer CUIT — WSFE rejects DocNro=0.
  if (input.tipoComprobante === 1 && !input.customerCuit) {
    throw new Error(
      "[wsfe] Factura tipo A requiere CUIT del comprador. Proporcioná el CUIT del cliente.",
    );
  }

  // NC/ND tipos (2,3,7,8,12,13) require a CbtesAsoc block — AFIP rejects without it.
  if (NC_ND_TIPOS.has(input.tipoComprobante) && !input.cbteAsoc) {
    throw new Error(
      "[wsfe] Las notas de crédito y débito requieren el comprobante asociado (número, " +
        "punto de venta y tipo de la factura original). Proporcioná los datos del comprobante original.",
    );
  }

  const ivaXml = buildIvaXml(input);

  // customerCuit is escaped in case of unexpected non-numeric content.
  const escapedCuit = input.customerCuit ? xmlEscape(input.customerCuit) : null;

  // CbtesAsoc block — emitted only when cbteAsoc is present (NC/ND types).
  const cbteAsocXml = input.cbteAsoc
    ? `<ar:CbtesAsoc>` +
      `<ar:CbteAsoc>` +
      `<ar:Tipo>${input.cbteAsoc.tipo}</ar:Tipo>` +
      `<ar:PtoVta>${input.cbteAsoc.ptoVta}</ar:PtoVta>` +
      `<ar:Nro>${input.cbteAsoc.nro}</ar:Nro>` +
      `</ar:CbteAsoc>` +
      `</ar:CbtesAsoc>`
    : "";

  const feDetReq =
    `<ar:FECAEDetRequest>` +
    `<ar:Concepto>${input.concepto}</ar:Concepto>` +
    `<ar:DocTipo>${escapedCuit ? 80 : 99}</ar:DocTipo>` + // 80=CUIT, 99=Sin identificar
    `<ar:DocNro>${escapedCuit ?? 0}</ar:DocNro>` +
    `<ar:CbteDesde>${cbteNro}</ar:CbteDesde>` +
    `<ar:CbteHasta>${cbteNro}</ar:CbteHasta>` +
    `<ar:CbteFch>${cbteDate}</ar:CbteFch>` +
    `<ar:ImpTotal>${input.importeTotal.toFixed(2)}</ar:ImpTotal>` +
    `<ar:ImpTotConc>${input.importeNoGravado.toFixed(2)}</ar:ImpTotConc>` +
    `<ar:ImpNeto>${input.importeNeto.toFixed(2)}</ar:ImpNeto>` +
    `<ar:ImpOpEx>${input.importeExento.toFixed(2)}</ar:ImpOpEx>` +
    `<ar:ImpIVA>${input.ivaItems.reduce((s, i) => s + i.importe, 0).toFixed(2)}</ar:ImpIVA>` +
    `<ar:ImpTrib>0.00</ar:ImpTrib>` +
    `<ar:MonId>PES</ar:MonId>` +
    `<ar:MonCotiz>1</ar:MonCotiz>` +
    ivaXml +
    cbteAsocXml +
    `</ar:FECAEDetRequest>`;

  return buildSoapEnvelope(
    wsfeNs,
    `<ar:FECAESolicitar>` +
    authXml(input.cuit, ticket) +
    `<ar:FeCAEReq>` +
    `<ar:FeCabReq>` +
    `<ar:CantReg>1</ar:CantReg>` +
    `<ar:PtoVta>${input.puntoVenta}</ar:PtoVta>` +
    `<ar:CbteTipo>${input.tipoComprobante}</ar:CbteTipo>` +
    `</ar:FeCabReq>` +
    `<ar:FeDetReq>${feDetReq}</ar:FeDetReq>` +
    `</ar:FeCAEReq>` +
    `</ar:FECAESolicitar>`,
  );
}

/**
 * Extracts all WSFE rejection errors from the real WSFE schema:
 *   <Errors><Err><Code>NNN</Code><Msg>text</Msg></Err></Errors>
 *
 * Falls back to the legacy <Obs>/<Err> tags for any partial responses.
 * Returns a human-readable string of all error codes + messages found.
 */
export function extractWsfeErrors(xml: string): string {
  const parts: string[] = [];

  // Primary path: <Errors><Err><Code>…</Code><Msg>…</Msg></Err></Errors>
  const errorsBlock = extractTag(xml, "Errors");
  if (errorsBlock) {
    const errRe = /<(?:[a-zA-Z0-9_]+:)?Err>[\s\S]*?<\/(?:[a-zA-Z0-9_]+:)?Err>/gi;
    let m: RegExpExecArray | null;
    while ((m = errRe.exec(errorsBlock)) !== null) {
      const code = extractTag(m[0], "Code") ?? extractTag(m[0], "Codigo") ?? "";
      const msg = extractTag(m[0], "Msg") ?? extractTag(m[0], "Descripcion") ?? m[0].slice(0, 80);
      parts.push(code ? `[${code}] ${msg}` : msg);
    }
  }

  // Secondary path: <Obs><Ob> blocks (observation warnings in approved responses)
  const obsBlock = extractTag(xml, "Obs");
  if (obsBlock && obsBlock.trim()) {
    const obRe = /<(?:[a-zA-Z0-9_]+:)?Ob>[\s\S]*?<\/(?:[a-zA-Z0-9_]+:)?Ob>/gi;
    let m: RegExpExecArray | null;
    while ((m = obRe.exec(obsBlock)) !== null) {
      const code = extractTag(m[0], "Code") ?? extractTag(m[0], "Codigo") ?? "";
      const msg = extractTag(m[0], "Msg") ?? extractTag(m[0], "Descripcion") ?? m[0].slice(0, 80);
      parts.push(code ? `Obs[${code}] ${msg}` : `Obs: ${msg}`);
    }
    if (!parts.some((p) => p.startsWith("Obs"))) parts.push(obsBlock.trim());
  }

  return parts.length > 0 ? parts.join(" | ") : "(sin detalle de error)";
}
