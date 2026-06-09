// src/lib/mcp/_lib/velora-logistica.adapter.ts — Velora concrete implementation of LogisticaBackend.
//
// Wraps the existing helpers from logistica-helpers.ts and getCourierEntry from
// the courier-registry. Pure restructure — zero behavioral change. tenantId is
// mapped to businessId before every call.
//
// Design mirrors velora-ventas.adapter.ts (composition over inheritance).
// The adapter is a thin delegation layer: it doesn't add logic, it translates shapes.
//
// NOTE: The COURIER_REGISTRY / getCourierEntry / ProviderAdapter internals are
// NOT touched — this adapter calls them as-is, satisfying the HARD CONSTRAINT
// that those lower-level pieces remain unchanged.

import type {
  LogisticaBackend,
  QuoteShippingInput,
  QuoteShippingResult,
  CreateShipmentInput,
  CreateShipmentResult,
  TrackShipmentInput,
  TrackShipmentResult,
  GetPackageProfileInput,
  PackageProfileResult,
} from "./logistica-backend.port";
import { resolveActiveCouriers } from "./logistica-helpers";
import { computePackageProfile } from "./logistica-package-profile";
import { getCourierEntry } from "@/app/api/agents/logistica/jsonrpc/_lib/courier-registry";

export class VeloraLogisticaAdapter implements LogisticaBackend {
  async resolveActiveCouriers(input: QuoteShippingInput): Promise<QuoteShippingResult> {
    const { tenantId: businessId } = input;
    const activeCouriers = await resolveActiveCouriers(businessId);
    return { activeCouriers };
  }

  async getCourierEntryForCreate(input: CreateShipmentInput): Promise<CreateShipmentResult> {
    const courierEntry = getCourierEntry(input.provider);
    return { courierEntry };
  }

  async getCourierEntryForTrack(input: TrackShipmentInput): Promise<TrackShipmentResult> {
    const courierEntry = getCourierEntry(input.provider);
    return { courierEntry };
  }

  async getPackageProfile(input: GetPackageProfileInput): Promise<PackageProfileResult> {
    const { tenantId: businessId, saleId, productIds, weightGramsOverride } = input;
    return computePackageProfile({ saleId, productIds, weightGramsOverride }, businessId);
  }
}
