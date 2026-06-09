// src/lib/mcp/_lib/logistica-backend.port.ts — Backend-agnostic port for logistica MCP tools.
//
// Decouples the 4 logistica tools from Velora's concrete courier/Prisma layer.
// A future FudoLogisticaAdapter (or any other backend) implements this interface
// and requires ZERO changes to logistica-tools.ts or the MCP server.
//
// Design mirrors ventas-backend.port.ts / engine-adapter.ts:
//   port (this file) → adapter (velora-logistica.adapter.ts) → factory (logistica-backend.factory.ts)
//
// tenantId is opaque here — the Velora adapter maps it to businessId internally
// so the port name doesn't hard-wire Velora's domain vocabulary.
//
// Courier I/O types are inlined from logistica-helpers.ts (CourierOption, PackageProfileResult).
// They are intentionally narrow (tool-contract shapes) — not the full domain types.
// The port is a seam, not a full domain model.

import type { CourierEntry } from "@/app/api/agents/logistica/jsonrpc/_lib/courier-registry";

// ── quoteShipping ──────────────────────────────────────────────────────────────

export interface QuoteShippingInput {
  tenantId: string;
  originPostalCode: string;
  destinationPostalCode: string;
  weightGrams: number;
  declaredValue?: number;
}

export interface QuoteShippingResult {
  activeCouriers: CourierEntry[];
}

// ── createShipment ─────────────────────────────────────────────────────────────

export interface CreateShipmentInput {
  tenantId: string;
  provider: string;
}

export interface CreateShipmentResult {
  courierEntry: CourierEntry | undefined;
}

// ── trackShipment ──────────────────────────────────────────────────────────────

export interface TrackShipmentInput {
  tenantId: string;
  provider: string;
}

export interface TrackShipmentResult {
  courierEntry: CourierEntry | undefined;
}

// ── getPackageProfile ─────────────────────────────────────────────────────────

export interface GetPackageProfileInput {
  tenantId: string;
  saleId?: string;
  productIds?: string[];
  weightGramsOverride?: number;
}

export interface PackageProfileResult {
  weightGrams: number;
  hasRealWeightData: boolean;
  itemCount: number;
  breakdown: Array<{ productId: string; quantity: number; weightGrams: number }>;
}

/**
 * Backend-agnostic logistica port for the MCP logistica tool pack.
 *
 * Each method maps to one MCP tool or a sub-operation within one:
 *   - resolveActiveCouriers → quote_shipping (fan-out phase)
 *   - getCourierEntryForCreate → create_shipment (lookup phase)
 *   - getCourierEntryForTrack  → track_shipment (lookup phase)
 *   - getPackageProfile        → get_package_profile
 *
 * The actual adapter.quote / adapter.create / adapter.track calls remain in
 * logistica-tools.ts because they carry inline error handling and response shaping
 * that is tool-layer logic, not infrastructure. The seam wraps only the
 * infrastructure dependencies (Prisma + COURIER_REGISTRY lookups).
 *
 * Throw an Error for infra failures — logistica-tools.ts converts them to
 * MCP isError responses.
 *
 * Tenant isolation is enforced by each adapter via the opaque tenantId field.
 */
export interface LogisticaBackend {
  resolveActiveCouriers(input: QuoteShippingInput): Promise<QuoteShippingResult>;
  getCourierEntryForCreate(input: CreateShipmentInput): Promise<CreateShipmentResult>;
  getCourierEntryForTrack(input: TrackShipmentInput): Promise<TrackShipmentResult>;
  getPackageProfile(input: GetPackageProfileInput): Promise<PackageProfileResult>;
}
