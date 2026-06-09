// fiscal-readiness.ts — checks whether a business CAN emit electronic invoices.
//
// Reads the DB for ArcaCredential + Business fiscal fields and returns a structured
// status that callers use to route the owner toward setup instead of a silent sandbox.
//
// Deliberately kept pure and side-effect-free beyond the DB read — no cloudLog,
// no mutation. Callers decide whether to surface the result.

import { prisma } from "@/lib/prisma";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface FiscalReadinessResult {
  /** True only when ALL required fields are present and an ArcaCredential row exists. */
  ready: boolean;
  /**
   * Human-readable labels of what is missing (in Spanish).
   * Empty array when ready === true.
   */
  missing: string[];
  /**
   * Warm Rioplatense-Spanish guidance for the owner explaining what is missing
   * and what they need to do to get electronic invoicing working.
   * Empty string when ready === true.
   */
  guidance: string;
}

// ── Helper: build guidance text ───────────────────────────────────────────────

function buildGuidance(missing: string[]): string {
  const missingList = missing.map((m) => `• ${m}`).join("\n");

  const arcaSteps =
    "Para emitir facturas electrónicas reales tenés que completar el trámite en ARCA:\n" +
    "1. Ingresá a https://auth.afip.gov.ar/ con tu Clave Fiscal.\n" +
    "2. Adherí el servicio WSFE (Web Service de Facturación Electrónica) desde el Administrador de Relaciones.\n" +
    "3. Registrá un Punto de Venta de tipo WebServices en Comprobantes en Línea.\n" +
    "4. Generá un certificado digital (.p12) desde Administrador de Relaciones → Certificados Digitales.\n" +
    "5. Una vez que tenés el .p12, subilo directamente desde Configuración → Certificado ARCA en Velora " +
    "(sección 'Datos fiscales y envíos'). No necesitás contactar soporte.\n\n" +
    "Mientras tanto, Velora puede emitir comprobantes en modo sandbox (sin validez fiscal real).";

  return (
    `Para poder emitir facturas electrónicas falta configurar lo siguiente:\n${missingList}\n\n` +
    arcaSteps
  );
}

// ── Main export ───────────────────────────────────────────────────────────────

/** Minimal business fields needed to evaluate fiscal readiness. */
export interface BusinessFiscalFields {
  cuit: string | null;
  ivaCondition: string | null;
  puntoVenta: string | null;
}

/**
 * Checks whether a business is fully ready to emit real ARCA electronic invoices.
 *
 * Required conditions:
 *   1. Business.cuit is set (non-null, 11-digit string).
 *   2. Business.ivaCondition is set.
 *   3. Business.puntoVenta is set (non-null, non-empty, non-"0" sentinel).
 *   4. An ArcaCredential row exists for the business.
 *
 * Note: the self-serve cert upload UI lives at Settings → Certificado ARCA
 * (POST /api/integrations/fiscal/connect). When ArcaCredential exists it was
 * created either via the self-serve flow or (historically) via a manual DB insert.
 *
 * @param prefetchedBusiness - Optional pre-fetched Business row. When provided
 *   the function skips its own `prisma.business.findUnique` call, eliminating a
 *   redundant DB round-trip for callers that already loaded the row (e.g.
 *   `handleFiscalRpc` which fetches the row to build `fiscalProfile`).
 */
export async function getFiscalReadiness(
  businessId: string,
  prefetchedBusiness?: BusinessFiscalFields | null,
): Promise<FiscalReadinessResult> {
  const [business, credential] = await Promise.all([
    prefetchedBusiness !== undefined
      ? Promise.resolve(prefetchedBusiness)
      : prisma.business.findUnique({
          where: { id: businessId },
          select: { cuit: true, ivaCondition: true, puntoVenta: true },
        }),
    prisma.arcaCredential.findUnique({
      where: { businessId },
      select: { businessId: true },
    }),
  ]);

  const missing: string[] = [];

  if (!business?.cuit || business.cuit.replace(/\D/g, "").length !== 11) {
    missing.push("CUIT del negocio (11 dígitos)");
  }

  if (!business?.ivaCondition || business.ivaCondition.trim() === "") {
    missing.push("Condición frente al IVA (Monotributista / Responsable Inscripto / Exento)");
  }

  // puntoVenta "0" is the sentinel value used when the owner deferred the step.
  const pv = business?.puntoVenta;
  if (!pv || pv.trim() === "" || pv === "0") {
    missing.push("Número de punto de venta (registrado en AFIP)");
  }

  if (!credential) {
    missing.push("Certificado digital .p12 (obtenido en el portal de ARCA con tu Clave Fiscal)");
  }

  if (missing.length === 0) {
    return { ready: true, missing: [], guidance: "" };
  }

  return {
    ready: false,
    missing,
    guidance: buildGuidance(missing),
  };
}
