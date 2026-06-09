// shipment.create skill — crea envío Andreani y persiste en AndreaniShipment.
//
// Flujo real:
//   1. Resolve contract codes from per-business credential or env vars (fail if absent).
//   2. Resolve sender data from Business profile (fail if required fields missing).
//   3. POST /v2/ordenes → obtiene nroAndreani + fechaEstimadaEntrega
//   4. GET /v2/ordenes/{nro}/etiqueta → descarga PDF blob
//   5. Upload PDF to GCS via uploadPdfToGcs + getSignedUrlForGcsKey (24h signed URL). Falls back
//      to storing the Andreani URL directly if GCS is not configured (sandbox/dev).
//   6. Upsert AndreaniShipment en DB (idempotente por saleId), stores GCS signed URL.
//
// Contract codes are account-specific and resolved per-business first (DB credential),
// then falling back to env vars (ANDREANI_CONTRATO_DOMICILIO/SUCURSAL/EXPRESS).

import { prisma } from "@/lib/prisma";
import { cloudLog } from "@/lib/cloud-logger";
import { uploadPdfToGcs, getSignedUrlForGcsKey, buildPdfR2Key } from "@/lib/r2";
import { resolveTokenWithEnv, resolveContractCodes, createOrden, andreaniFetch, isAndreaniCircuitOpen } from "./andreani-api-client";
import { isAndreaniMockActive } from "./andreani-mock";
import type { CreateShipmentInput, CreateShipmentResult } from "./types";
import { writebackShipment } from "./shipment-writeback";

// ── Sender data resolution ────────────────────────────────────────────────────

interface SenderData {
  nombreCompleto: string;
  email: string;
  documentoTipo: "CUIT" | "DNI";
  documentoNumero: string;
  telefonoNumero: string;
}

/**
 * Load sender (remitente) data from the Business profile.
 * Andreani requires: business name, document number (CUIT preferred for commercial
 * accounts), email, and phone. If required fields are missing, fails with a clear
 * message telling the owner which fields to complete in their business profile.
 */
async function resolveSenderData(businessId: string): Promise<SenderData> {
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: { name: true, cuit: true, phone: true, email: true },
  });

  if (!business) {
    throw new Error(`Business ${businessId} not found — cannot resolve sender data.`);
  }

  const missing: string[] = [];

  const nombre = business.name.trim();
  if (!nombre) missing.push("nombre del negocio");

  const cuit = (business.cuit ?? "").trim().replace(/[-\s]/g, "");
  if (!cuit) missing.push("CUIT (Settings → Perfil fiscal)");

  const telefono = (business.phone ?? "").trim();
  if (!telefono) missing.push("teléfono (Settings → Datos del negocio)");

  const correo = (business.email ?? "").trim();
  if (!correo) missing.push("email del negocio (Settings → Datos del negocio)");

  if (missing.length > 0) {
    throw new Error(
      "Para crear un envío real con Andreani, completá los siguientes datos de tu negocio: " +
      missing.join(", ") +
      ". Andá a Configuración → Datos del negocio.",
    );
  }

  return {
    nombreCompleto:  nombre,
    email:           correo,
    documentoTipo:   "CUIT",
    documentoNumero: cuit,
    telefonoNumero:  telefono,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function estimatedDeliveryFromDays(service: string): string {
  const today = new Date();
  const days = service === "express" ? 1 : service === "domicilio" ? 3 : 5;
  today.setDate(today.getDate() + days);
  return today.toISOString().split("T")[0] ?? today.toISOString();
}

// ── Main skill ────────────────────────────────────────────────────────────────

// ── Constants ─────────────────────────────────────────────────────

const PRODUCT_DESCRIPTION = "Producto Velora";
const DEFAULT_VOLUME_M3 = 0.001; // 1 litre default for unknown package dimensions

// ── Main skill ─────────────────────────────────────────────────────

export async function shipmentCreate(
  input: CreateShipmentInput,
  businessId: string,
): Promise<CreateShipmentResult> {
  // Fail fast: check config before hitting Andreani's API.
  const contracts = await resolveContractCodes(businessId);
  const sender    = await resolveSenderData(businessId);
  const { ctx, environment } = await resolveTokenWithEnv(businessId);

  const contractCode = contracts[input.service] ?? contracts.domicilio;

  // Customer DNI is required by Andreani production. Surface a clear error
  // when missing so the owner can provide it before the API rejects the order.
  const customerDni = (input.customer.dni ?? "").trim();
  if (!customerDni && !isAndreaniMockActive(businessId)) {
    throw new Error(
      `El cliente "${input.customer.name}" no tiene DNI registrado. ` +
      "Para crear un envío con Andreani en producción el DNI del destinatario es obligatorio. " +
      "Indicá el DNI del cliente para continuar.",
    );
  }
  // In mock/sandbox mode, accept any non-empty DNI or fall back to a safe placeholder.
  const documentoNumero = customerDni || "00000000";

  const orderPayload = {
    contrato: contractCode,
    bultos: [
      {
        kilos:          Math.max(1, Math.ceil(input.weightGrams / 1000)),
        volumen:        DEFAULT_VOLUME_M3,
        valorDeclarado: input.declaredValue ?? 0,
        descripcion:    PRODUCT_DESCRIPTION,
      },
    ],
    remitente: sender,
    destinatario: {
      nombreCompleto:  input.customer.name,
      email:           "",             // customer email is optional for Andreani
      documentoTipo:   "DNI",
      documentoNumero: documentoNumero,
      telefonoNumero:  input.customer.phone,
    },
    domicilioDestino: {
      calle:        input.customer.address,
      codigoPostal: input.customer.postalCode,
      localidad:    input.customer.city ?? "",
      provincia:    "",
    },
  };

  const ordenResult = await createOrden(orderPayload, ctx, businessId, environment);
  if (isAndreaniCircuitOpen(ordenResult)) {
    throw new Error(ordenResult.message);
  }
  const orden = ordenResult;
  const trackingNumber = orden.nroAndreani;

  // Fetch label PDF and upload to GCS. Persist the bare GCS key — NOT a signed URL.
  // Signed URLs expire in 15 min; storing the key lets any consumer generate a fresh
  // URL on-demand via getAndreaniLabelSignedUrl(). Falls back to storing Andreani's own
  // URL when GCS is not configured (sandbox/dev — no TTL concern there).
  let labelPdfPath: string | null = null;
  let labelPdfUrl: string | null = null; // on-demand signed URL returned to caller only
  try {
    const labelRes = await andreaniFetch(
      `/v2/ordenes/${trackingNumber}/etiqueta`,
      { method: "GET", headers: { Accept: "application/pdf" } },
      ctx,
      businessId,
      environment,
    );
    if (labelRes.ok) {
      const pdfBuffer = Buffer.from(await labelRes.arrayBuffer());
      const gcsKey = buildPdfR2Key("label", businessId, input.saleId, trackingNumber);
      const storedKey = await uploadPdfToGcs(gcsKey, pdfBuffer);
      if (storedKey) {
        // GCS configured: persist bare key; generate a one-time signed URL for the caller.
        labelPdfPath = storedKey;
        labelPdfUrl = await getSignedUrlForGcsKey(storedKey);
      } else {
        // GCS not configured (local dev / sandbox): fall back to Andreani's own URL.
        labelPdfPath = labelRes.url;
        labelPdfUrl  = labelRes.url;
      }
      cloudLog({
        severity: "INFO", component: "A2A", action: "ANDREANI_LABEL_STORED",
        a2a_transfer: false,
        message: storedKey ? "Label PDF uploaded to GCS (key stored)" : "Label PDF stored as Andreani URL (GCS not configured)",
        data: { trackingNumber, saleId: input.saleId, usingGcs: Boolean(storedKey) },
      });
    }
  } catch (err) {
    cloudLog({
      severity: "WARNING", component: "A2A", action: "ANDREANI_LABEL_FETCH_FAIL",
      a2a_transfer: false, message: "Label fetch/upload failed, continuing without",
      data: { trackingNumber, error: err instanceof Error ? err.message : String(err) },
    });
  }

  const estimatedDelivery = orden.fechaEstimadaEntrega
    ? new Date(orden.fechaEstimadaEntrega)
    : new Date(estimatedDeliveryFromDays(input.service));

  // Phase 2 S4: persist the shipment via the internal core endpoint instead of
  // writing directly to the DB. This removes the Andreani agent's direct Prisma
  // dependency for shipment creation. Hard stop on failure — a shipment-create
  // that fails to persist must surface the error, not pretend success.
  await writebackShipment({
    businessId,
    saleId:            input.saleId,
    trackingNumber,
    service:           input.service,
    labelPdfPath,      // bare GCS key (or mock URL) — never a signed URL
    estimatedDelivery,
  });

  cloudLog({
    severity: "INFO", component: "A2A", action: "ANDREANI_SHIPMENT_CREATED",
    a2a_transfer: false, message: `Shipment created ${trackingNumber}`,
    data: { trackingNumber, saleId: input.saleId, businessId },
  });

  return {
    trackingNumber,
    labelPdfUrl,
    estimatedDelivery: estimatedDelivery.toISOString().split("T")[0] ?? estimatedDelivery.toISOString(),
    service: input.service,
  };
}
