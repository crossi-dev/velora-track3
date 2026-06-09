// PedidosYa mock-mode helpers for the Logística role-agent.
//
// Set PEDIDOSYA_MOCK_MODE=true to run PedidosYa demo flows without real
// partner credentials. Mirrors the andreani-mock.ts pattern exactly.
//
// Required until partner credentials are provisioned at:
//   https://envios.pedidosya.com  (country-specific registration)
//
// Do NOT enable in production with real partner accounts.

import { randomUUID } from "crypto";
import { cloudLog } from "@/lib/cloud-logger";
import type {
  PedidosYaQuoteOption,
  PedidosYaQuoteResult,
  PedidosYaCreateResult,
  PedidosYaTrackResult,
} from "./pedidosya-types";

// ── Mock-mode guard ───────────────────────────────────────────────────────────

/**
 * Returns true when PEDIDOSYA_MOCK_MODE=true (case-insensitive).
 *
 * SAFETY MODEL (mirrors AndreaniAdapter pattern):
 * - Default in production: fail-closed (throw) so mock data never reaches
 *   real owners without explicit opt-in.
 * - Explicit escape: PEDIDOSYA_ALLOW_MOCK_IN_PROD=true opts in and logs WARNING.
 */
export function isPedidosYaMockEnabled(): boolean {
  const enabled = (process.env.PEDIDOSYA_MOCK_MODE ?? "").toLowerCase() === "true";
  if (enabled && process.env.NODE_ENV === "production") {
    const allowed = (process.env.PEDIDOSYA_ALLOW_MOCK_IN_PROD ?? "").toLowerCase() === "true";
    if (!allowed) {
      throw new Error(
        "[velora] PEDIDOSYA_MOCK_MODE=true is not allowed in production. " +
          "Either unset PEDIDOSYA_MOCK_MODE or set PEDIDOSYA_ALLOW_MOCK_IN_PROD=true to opt in explicitly.",
      );
    }
  }
  return enabled;
}

/**
 * Non-throwing variant for tool-visibility gating decisions.
 * Mirrors isAndreaniMockActive() — safe to call inside stateDelta builders.
 */
export function isPedidosYaMockActive(): boolean {
  if ((process.env.PEDIDOSYA_MOCK_MODE ?? "").toLowerCase() !== "true") return false;
  if (process.env.NODE_ENV === "production") {
    return (process.env.PEDIDOSYA_ALLOW_MOCK_IN_PROD ?? "").toLowerCase() === "true";
  }
  return true;
}

// Startup alarm — mirrors andreani-mock.ts pattern.
(() => {
  if (process.env.NODE_ENV !== "production") return;
  if ((process.env.PEDIDOSYA_MOCK_MODE ?? "").toLowerCase() !== "true") return;
  const allowed = (process.env.PEDIDOSYA_ALLOW_MOCK_IN_PROD ?? "").toLowerCase() === "true";
  cloudLog({
    severity: allowed ? "WARNING" : "ERROR",
    component: "A2A",
    action: allowed ? "PEDIDOSYA_MOCK_ACTIVE_IN_PRODUCTION_OPT_IN" : "PEDIDOSYA_MOCK_ACTIVE_IN_PRODUCTION",
    a2a_transfer: false,
    message: allowed
      ? "PEDIDOSYA_MOCK_MODE=true with PEDIDOSYA_ALLOW_MOCK_IN_PROD=true — synthetic data active."
      : "PEDIDOSYA_MOCK_MODE=true in production without opt-in — all PedidosYa calls will be rejected.",
    data: {},
  });
})();

// ── Mock data ─────────────────────────────────────────────────────────────────

const MOCK_QUOTE_OPTIONS: PedidosYaQuoteOption[] = [
  { service: "moto",    serviceLabel: "Moto (mismo día)", priceARS: 900,  estimatedDays: 0, estimatedMinutes: 45  },
  { service: "auto",    serviceLabel: "Auto (mismo día)", priceARS: 1500, estimatedDays: 0, estimatedMinutes: 60  },
  { service: "express", serviceLabel: "Express (2 hs)",  priceARS: 2200, estimatedDays: 0, estimatedMinutes: 120 },
];

export function mockPedidosYaQuote(
  originPostalCode: string,
  destinationPostalCode: string,
): PedidosYaQuoteResult {
  return {
    originPostalCode,
    destinationPostalCode,
    provider: "pedidosya",
    options: MOCK_QUOTE_OPTIONS,
  };
}

export function mockPedidosYaCreate(
  _saleId: string,
  businessId: string,
): PedidosYaCreateResult {
  const orderId = `PYA-${businessId.slice(-5)}-${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
  return {
    trackingNumber:   orderId,
    orderId,
    confirmationCode: randomUUID().slice(0, 8).toUpperCase(),
    labelUrl:         null,
    estimatedDelivery: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
    service: "moto",
  };
}

export function mockPedidosYaTrack(orderId: string): PedidosYaTrackResult {
  return {
    trackingNumber: orderId,
    provider: "pedidosya",
    status: "IN_PROGRESS",
    events: [
      {
        timestamp: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
        description: "Pedido asignado al repartidor",
        location: "Punto de pickup",
      },
      {
        timestamp: new Date().toISOString(),
        description: "Repartidor en camino",
        location: "En tránsito",
      },
    ],
  };
}
