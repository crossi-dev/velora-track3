// Andreani Agent — Mock mode helpers.
// Set ANDREANI_MOCK_MODE=true to run the full agent demo flow without Andreani credentials.
//
// Used by the JSON-RPC dispatcher (handle-andreani-rpc.ts).
// Each function returns synthetic but realistic data that demonstrates the end-to-end flow.
//
// Mock mode is safe to enable in Cloud Run for the Google AI Agents Challenge demo.
// Do NOT enable in production with real Andreani accounts.

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { cloudLog } from "@/lib/cloud-logger";
import { isDemoBusiness } from "@/lib/demo-business";
import type {
  QuoteInput,
  QuoteResult,
  CreateShipmentInput,
  CreateShipmentResult,
  TrackInput,
  TrackResult,
  TrackingEvent,
} from "./types";

/**
 * Canonical mock-mode check for all Andreani paths.
 * MOCK when ANDREANI_MOCK_MODE=true (case-insensitive).
 * REAL when the var is absent or any other value (production default).
 *
 * SAFETY MODEL:
 * - Default behavior in NODE_ENV=production: fail-closed (throw) if mock is on,
 *   so accidentally-deployed mock mode never writes synthetic data to the real
 *   production DB or returns fake quotes to a real owner.
 * - Explicit escape hatch ANDREANI_ALLOW_MOCK_IN_PROD=true: lets the team run
 *   the demo in prod with mock data on purpose (Google contest, live tester
 *   sessions). When set, mock activates and a WARNING fires per call so the
 *   intent stays auditable in Cloud Logs.
 * - Choice: throw at call-site (not at import) so dev/test environments can
 *   still load the module freely; only live invocations in prod are blocked.
 */
export function isMockEnabled(): boolean {
  const enabled = (process.env.ANDREANI_MOCK_MODE ?? "").toLowerCase() === "true";
  if (enabled && process.env.NODE_ENV === "production") {
    const allowed = (process.env.ANDREANI_ALLOW_MOCK_IN_PROD ?? "").toLowerCase() === "true";
    if (!allowed) {
      throw new Error(
        "[velora] ANDREANI_MOCK_MODE=true is not allowed in production. " +
          "Either unset ANDREANI_MOCK_MODE or set ANDREANI_ALLOW_MOCK_IN_PROD=true to opt in explicitly.",
      );
    }
  }
  return enabled;
}

// Startup alarm: in NODE_ENV=production with mocks enabled, log so the
// situation is visible in Cloud Logging dashboards before the first request hits.
// Severity depends on whether the explicit escape hatch is set:
// - escape hatch absent → ERROR (mock will throw, all Andreani calls reject)
// - escape hatch present → WARNING (mock active by explicit owner choice)
(() => {
  if (process.env.NODE_ENV !== "production") return;
  if ((process.env.ANDREANI_MOCK_MODE ?? "").toLowerCase() !== "true") return;
  const allowed = (process.env.ANDREANI_ALLOW_MOCK_IN_PROD ?? "").toLowerCase() === "true";
  cloudLog({
    severity: allowed ? "WARNING" : "ERROR",
    component: "A2A",
    action: allowed ? "ANDREANI_MOCK_ACTIVE_IN_PRODUCTION_OPT_IN" : "ANDREANI_MOCK_ACTIVE_IN_PRODUCTION",
    a2a_transfer: false,
    message: allowed
      ? "ANDREANI_MOCK_MODE=true with ANDREANI_ALLOW_MOCK_IN_PROD=true — synthetic data WILL be returned to real owners. Unset both vars before going to real customers."
      : "ANDREANI_MOCK_MODE=true while NODE_ENV=production and ANDREANI_ALLOW_MOCK_IN_PROD is NOT set. All Andreani calls will be rejected (fail-closed).",
    data: {},
  });
})();

/** @alias isMockEnabled — use this where the import is already from andreani-mock */
export const isAndreaniMockMode = isMockEnabled;

/**
 * Non-throwing variant of isMockEnabled() for tool-visibility gating decisions.
 *
 * isMockEnabled() THROWS in NODE_ENV=production when mock is on without the
 * explicit ANDREANI_ALLOW_MOCK_IN_PROD opt-in — correct at the actual Andreani
 * call site (fail-closed on invocation), but unsafe inside the capability-state
 * builder: a throw there would abort the ENTIRE app:* stateDelta and
 * fail-closed-hide every gated tool (payments, fiscal — not just shipping).
 *
 * This returns the same boolean isMockEnabled() would return, but yields false
 * instead of throwing in the disallowed-prod case. Use for gating; use
 * isMockEnabled() at the call site where the throw is the desired behavior.
 *
 * Per-business gate: when businessId is provided, mock is only active for demo
 * businesses (DEMO_BUSINESS_IDS env var). Real businesses always get real mode
 * even when the global ANDREANI_MOCK_MODE flag is on.
 */
export function isAndreaniMockActive(businessId?: string): boolean {
  if ((process.env.ANDREANI_MOCK_MODE ?? "").toLowerCase() !== "true") return false;
  if (process.env.NODE_ENV === "production") {
    if ((process.env.ANDREANI_ALLOW_MOCK_IN_PROD ?? "").toLowerCase() !== "true") return false;
  }
  // Per-business gate: if a businessId is supplied, only demo businesses get mock mode.
  // Callers that cannot supply a businessId fall through to global flag behavior.
  if (businessId !== undefined && !isDemoBusiness(businessId)) return false;
  return true;
}

/**
 * Returns true when the tracking number was generated by mock mode.
 * Mock tracking numbers use the "ARK-" prefix (e.g. ARK-abc123-def456789012).
 * Real Andreani tracking numbers never start with "ARK-".
 *
 * Use this guard before building customer-facing URLs that point to
 * https://www.andreani.com/seguimiento/{tn} — the URL will 404 for mock
 * numbers and should instead be replaced with a "(simulación)" label.
 */
export function isAndreaniMockTracking(trackingNumber: string): boolean {
  return trackingNumber.startsWith("ARK-");
}

// ── Mock data ─────────────────────────────────────────────────────────────────

const MOCK_QUOTE_OPTIONS = [
  { service: "sucursal"  as const, serviceLabel: "Retiro en sucursal", priceARS: 850,  estimatedDays: 5 },
  { service: "domicilio" as const, serviceLabel: "Envío a domicilio",  priceARS: 1200, estimatedDays: 3 },
  { service: "express"   as const, serviceLabel: "Express (24 hs)",    priceARS: 2400, estimatedDays: 1 },
];

function mockTrackingEvents(trackingNumber: string): TrackingEvent[] {
  return [
    { timestamp: new Date(Date.now() - 2 * 86_400_000).toISOString(),
      status: "creado", description: "Orden de despacho ingresada al sistema", location: "Velora Business" },
    { timestamp: new Date(Date.now() - 86_400_000).toISOString(),
      status: "en_transito", description: "En tránsito hacia sucursal destino", location: "Centro de Distribución CABA" },
    { timestamp: new Date().toISOString(),
      status: "en_transito", description: `En ruta para entrega — ${trackingNumber}`, location: "Sucursal Destino" },
  ];
}

// ── Mock skill implementations ────────────────────────────────────────────────

export function mockShipmentQuote(input: QuoteInput): QuoteResult {
  return {
    options: MOCK_QUOTE_OPTIONS,
    originPostalCode: input.originPostalCode,
    destinationPostalCode: input.destinationPostalCode,
  };
}

export async function mockShipmentCreate(
  input: CreateShipmentInput,
  businessId: string,
): Promise<CreateShipmentResult> {
  const trackingNumber = `ARK-${businessId.slice(-6)}-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const deliveryDays = input.service === "express" ? 1 : input.service === "domicilio" ? 3 : 5;
  const estimatedDelivery = new Date(Date.now() + deliveryDays * 86_400_000);
  const labelPdfUrl = `https://developers-sandbox.andreani.com/mock/etiqueta/${trackingNumber}.pdf`;

  await prisma.andreaniShipment.upsert({
    where: { saleId: input.saleId },
    create: {
      businessId,
      saleId: input.saleId,
      trackingNumber,
      service: input.service,
      status: "created",
      labelPdfPath: labelPdfUrl,
      estimatedDelivery,
      events: mockTrackingEvents(trackingNumber) as unknown as Prisma.InputJsonValue,
    },
    update: {
      trackingNumber,
      service: input.service,
      status: "created",
      labelPdfPath: labelPdfUrl,
      estimatedDelivery,
      events: mockTrackingEvents(trackingNumber) as unknown as Prisma.InputJsonValue,
    },
  });

  cloudLog({ severity: "INFO", component: "A2A", action: "ANDREANI_SHIPMENT_CREATED_MOCK",
    a2a_transfer: false, message: `Mock shipment created ${trackingNumber}`,
    data: { trackingNumber, saleId: input.saleId, businessId } });

  return {
    trackingNumber,
    labelPdfUrl,
    estimatedDelivery: estimatedDelivery.toISOString().split("T")[0] ?? estimatedDelivery.toISOString(),
    service: input.service,
  };
}

export function mockShipmentTrack(input: TrackInput): TrackResult {
  const events = mockTrackingEvents(input.trackingNumber);
  return {
    trackingNumber: input.trackingNumber,
    currentStatus: "in_transit",
    events,
  };
}
