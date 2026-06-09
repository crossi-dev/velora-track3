// OCA e-Pak client — SOAP-style HTTP wrapper for the e-Pak tracking service.
//
// Base URL: https://webservice.oca.com.ar/ePak_tracking/
// Auth: usr + psw passed as query/body parameters on every call (e-Pak style, not bearer).
// Response encoding: XML ISO-8859-1.
//
// Endpoints implemented:
//   Tarifar_Envio_Corporativo — quote shipping cost + delivery time (GET with QS)
//   IngresoORMultiplesRetiros — create shipment order (POST with form body + XML)
//
// SECURITY: password/psw is NEVER logged. It appears in request params over TLS only.

import { cloudLog } from "@/lib/cloud-logger";
import { withOcaCircuit } from "./oca-circuit";
import type { OcaTarifaOption, OcaCreateResult } from "./types";

export const EPAK_BASE = "https://webservice.oca.com.ar/ePak_tracking";
const HTTP_TIMEOUT_MS  = 12_000;

// ── XML helpers ───────────────────────────────────────────────────────────────

/** Extract text content of first matching XML tag (single-line only). */
export function extractTagText(xml: string, tag: string): string {
  const re = new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, "i");
  const m = re.exec(xml);
  return m ? m[1].trim() : "";
}

/** Parse OCA e-Pak Tarifar_Envio_Corporativo XML into typed options. */
export function parseTarifaXml(xml: string): OcaTarifaOption[] {
  const options: OcaTarifaOption[] = [];
  const blockRe = /<aTarifacion[\s\S]*?<\/aTarifacion>/gi;
  let match: RegExpExecArray | null;
  while ((match = blockRe.exec(xml)) !== null) {
    const block        = match[0];
    const descripcion  = extractTagText(block, "Descripcion");
    const precioStr    = extractTagText(block, "Precio");
    const plazoStr     = extractTagText(block, "PlazoEntrega");
    const idTipoEnvio  = extractTagText(block, "idTipoEnvio");
    const priceARS     = parseFloat(precioStr);
    const days         = parseInt(plazoStr, 10);
    if (!descripcion || isNaN(priceARS) || isNaN(days)) continue;
    const serviceKey = idTipoEnvio
      ? `oca_tipo_${idTipoEnvio}`
      : `oca_${descripcion.toLowerCase().replace(/\s+/g, "_").slice(0, 24)}`;
    options.push({ service: serviceKey, serviceLabel: `OCA ${descripcion}`, priceARS, estimatedDays: days });
  }
  return options;
}

// ── Tarifar_Envio_Corporativo ─────────────────────────────────────────────────

export interface TarifaParams {
  cuit:          string;
  operativa:     string;
  originPostal:  string;
  destPostal:    string;
  weightKg:      number;
  volumeM3:      number;
  packages:      number;
  declaredValue: number;
  usuario:       string;
  /** SECURITY: sent over TLS only; never logged. */
  password:      string;
}

/**
 * Quote shipping cost via e-Pak Tarifar_Envio_Corporativo.
 * Returns empty array on API error (non-fatal for compare_rates fan-out).
 */
export async function fetchTarifas(params: TarifaParams): Promise<OcaTarifaOption[]> {
  return withOcaCircuit("oca.quote", async () => {
    const qs = new URLSearchParams({
      CUIT:                params.cuit,
      Operativa:           params.operativa,
      CodigoPostalOrigen:  params.originPostal,
      CodigoPostalDestino: params.destPostal,
      PesoTotal:           String(params.weightKg),
      VolumenTotal:        String(params.volumeM3),
      CantidadPaquetes:    String(params.packages),
      ValorDeclarado:      String(params.declaredValue),
      usr:                 params.usuario,
      // SECURITY: psw over TLS only, never logged.
      psw:                 params.password,
    });
    const url = `${EPAK_BASE}/Tarifar_Envio_Corporativo?${qs.toString()}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url, { method: "GET", signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      cloudLog({
        severity: "WARNING", component: "A2A", action: "OCA_TARIFA_ERROR",
        a2a_transfer: false, message: `OCA Tarifar_Envio_Corporativo HTTP ${res.status}`,
        data: { originPostal: params.originPostal, destPostal: params.destPostal, status: res.status },
      });
      return [];
    }
    return parseTarifaXml(await res.text());
  }, []);
}

// ── IngresoORMultiplesRetiros (create shipment) ───────────────────────────────

export interface ShipmentParams {
  usuario:            string;
  /** SECURITY: sent over TLS only; never logged. */
  password:           string;
  nroCuenta:          string;
  operativa:          string;
  saleId:             string;
  recipientName:      string;
  /** Optional last name — passed separately when available (OCA Apellido field). */
  recipientLastName?: string;
  recipientAddr:      string;
  /** Street number (Numero de calle) — required for domicilio delivery. */
  recipientAddrNumber: string;
  recipientPostal:    string;
  recipientCity:      string;
  /** Province name — required for domicilio delivery (e.g. "Buenos Aires"). */
  recipientProvince:  string;
  recipientPhone:     string;
  weightKg:           number;
  heightCm:           number;
  widthCm:            number;
  lengthCm:           number;
}

function buildShipmentXml(p: ShipmentParams): string {
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // Guard: OCA requires Numero and Provincia for domicilio delivery.
  // Reject early rather than sending an XML that will be silently rejected.
  if (!p.recipientAddrNumber.trim()) {
    throw new Error(
      "OCA IngresoORMultiplesRetiros: recipientAddrNumber (Numero de calle) es requerido para envío a domicilio.",
    );
  }
  if (!p.recipientProvince.trim()) {
    throw new Error(
      "OCA IngresoORMultiplesRetiros: recipientProvince (Provincia) es requerido para envío a domicilio.",
    );
  }

  // IngresoORMultiplesRetiros receives XML_Datos as a form-encoded POST body.
  // The XML is flat (no SOAP envelope, no namespace prefixes). NroCuenta and
  // CentroImposicionOrigen are plain tags inside <Header>.
  return [
    `<Envelope>`,
    `  <Header>`,
    `    <NroCuenta>${esc(p.nroCuenta)}</NroCuenta>`,
    `    <CentroImposicionOrigen>0</CentroImposicionOrigen>`,
    `  </Header>`,
    `  <Shipment>`,
    `    <Operativa>${esc(p.operativa)}</Operativa>`,
    `    <Reference>${esc(p.saleId)}</Reference>`,
    `    <Destinatario>`,
    `      <Nombre>${esc(p.recipientName)}</Nombre>`,
    `      <Apellido>${esc(p.recipientLastName ?? "")}</Apellido>`,
    `      <Calle>${esc(p.recipientAddr)}</Calle>`,
    `      <Numero>${esc(p.recipientAddrNumber)}</Numero>`,
    `      <CP>${esc(p.recipientPostal)}</CP>`,
    `      <Localidad>${esc(p.recipientCity)}</Localidad>`,
    `      <Provincia>${esc(p.recipientProvince)}</Provincia>`,
    `      <Telefono>${esc(p.recipientPhone)}</Telefono>`,
    `      <email></email>`,
    `    </Destinatario>`,
    `    <Bultos>`,
    `      <Bulto>`,
    `        <Alto>${p.heightCm}</Alto>`,
    `        <Ancho>${p.widthCm}</Ancho>`,
    `        <Largo>${p.lengthCm}</Largo>`,
    `        <Peso>${p.weightKg}</Peso>`,
    `      </Bulto>`,
    `    </Bultos>`,
    `    <ConfirmarRetiro>true</ConfirmarRetiro>`,
    `  </Shipment>`,
    `</Envelope>`,
  ].join("\n");
}

/**
 * Create a shipment via e-Pak IngresoORMultiplesRetiros.
 * Returns a trackingNumber (idOrdenRetiro) on success.
 */
export async function crearEnvio(params: ShipmentParams): Promise<OcaCreateResult> {
  const xmlDatos = buildShipmentXml(params);
  return withOcaCircuit(
    "oca.create",
    async () => {
      const body = new URLSearchParams({
        usr:             params.usuario,
        // SECURITY: psw over TLS only, never logged.
        psw:             params.password,
        XML_Datos:       xmlDatos,
        ConfirmarRetiro: "true",
        returnInfo:      "true",
      });
      const url = `${EPAK_BASE}/IngresoORMultiplesRetiros`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
      let res: Response;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: body.toString(),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      const text = await res.text();
      if (!res.ok) {
        throw new Error(`OCA IngresoORMultiplesRetiros HTTP ${res.status}: ${text.slice(0, 300)}`);
      }
      const resultado = extractTagText(text, "Resultado");
      if (resultado !== "100") {
        throw new Error(`OCA IngresoORMultiplesRetiros resultado=${resultado} (expected 100)`);
      }
      const idOrden = extractTagText(text, "IdOrdenRetiro") || extractTagText(text, "idOrdenRetiro");
      if (!idOrden) {
        throw new Error("OCA IngresoORMultiplesRetiros: no IdOrdenRetiro in response");
      }
      // Return the label URL WITHOUT credentials — the URL is shown to the owner
      // and must not expose the password. The owner can print the label by opening
      // OCA's tracking portal directly, or by navigating to their OCA account.
      // The full URL with psw is NOT built here; server-side label fetching (GCS
      // upload path) is a post-demo hardening item.
      const labelUrlPublic =
        `${EPAK_BASE}/GetPdfDeEtiquetasPorOrdenOrNumeroEnvio` +
        `?idOrdenRetiro=${encodeURIComponent(idOrden)}&nroEnvio=&logisticaInversa=false`;

      return {
        saleId:            params.saleId,
        trackingNumber:    idOrden,
        labelUrl:          labelUrlPublic,
        estimatedDelivery: null,
        service:           `oca_operativa_${params.operativa}`,
        provider:          "oca",
      } satisfies OcaCreateResult;
    },
    {
      saleId:            params.saleId,
      trackingNumber:    "",
      labelUrl:          "",
      estimatedDelivery: null,
      service:           `oca_operativa_${params.operativa}`,
      provider:          "oca",
    } satisfies OcaCreateResult,
  );
}
