// A2A v0.3.0 JSON-RPC dispatcher for the Andreani Agent.
// Supports method "message/send" with skill routing via params.skill.
// Mock mode: set ANDREANI_MOCK_MODE=true to run without real Andreani credentials.
// Shared JSON-RPC wire types → @/lib/a2a/jsonrpc-types

import { randomUUID } from "crypto";
import { cloudLog } from "@/lib/cloud-logger";
import { shipmentQuote } from "./shipment-quote";
import { shipmentCreate } from "./shipment-create";
import { shipmentTrack } from "./shipment-track";
import {
  mockShipmentQuote,
  mockShipmentCreate,
  mockShipmentTrack,
  isAndreaniMockActive,
} from "./andreani-mock";
import type { QuoteInput, CreateShipmentInput, TrackInput } from "./types";
import {
  type JsonRpcRequest,
  type JsonRpcErrorBody,
  type JsonRpcResultBody,
  type JsonRpcResponse,
  RPC_ERRORS,
  rpcError,
  rpcResult,
} from "@velora/core-utils/jsonrpc-types";

export type { JsonRpcRequest, JsonRpcResponse };
export { RPC_ERRORS, rpcError };

// Suppress unused-type lint: JsonRpcErrorBody/JsonRpcResultBody are consumed by the
// re-exported JsonRpcResponse union; the local aliases keep the import exhaustive.
type _Unused = JsonRpcErrorBody | JsonRpcResultBody;

// Per-business mock gate: mock only for demo businesses (isAndreaniMockActive).
// This replaces the old global isAndreaniMockMode alias so that non-demo businesses
// always reach the real Andreani even when ANDREANI_MOCK_MODE=true globally.

function extractParams(params: unknown): Record<string, unknown> {
  if (params && typeof params === "object" && !Array.isArray(params)) {
    return params as Record<string, unknown>;
  }
  return {};
}

function requireString(params: Record<string, unknown>, key: string): string | null {
  const v = params[key];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function requireNumber(params: Record<string, unknown>, key: string): number | null {
  const v = params[key];
  return typeof v === "number" && v > 0 ? v : null;
}

// ── Main dispatcher ───────────────────────────────────────────────────────────

export async function handleAndreaniRpc(body: JsonRpcRequest): Promise<JsonRpcResponse> {
  if (!body || body.jsonrpc !== "2.0" || typeof body.method !== "string") {
    return rpcError(body?.id, RPC_ERRORS.INVALID_REQUEST);
  }

  switch (body.method) {
    case "message/send":
      return handleSkillDispatch(body);
    case "tasks/get":
    case "tasks/cancel":
      return rpcError(body.id, RPC_ERRORS.TASK_NOT_FOUND);
    default:
      return rpcError(body.id, RPC_ERRORS.METHOD_NOT_FOUND);
  }
}

async function handleSkillDispatch(body: JsonRpcRequest): Promise<JsonRpcResponse> {
  const params = extractParams(body.params);
  const skill = requireString(params, "skill");
  const businessId = requireString(params, "businessId");

  if (!skill) return rpcError(body.id, RPC_ERRORS.INVALID_PARAMS, "params.skill is required");
  if (!businessId) return rpcError(body.id, RPC_ERRORS.INVALID_PARAMS, "params.businessId is required");
  // Validate CUID format to prevent cross-tenant namespace injection via crafted params.
  // A valid Prisma CUID is 25 lowercase alphanumeric chars; allow 20-30 for tolerance.
  if (!/^[a-z0-9]{20,30}$/.test(businessId)) {
    return rpcError(body.id, RPC_ERRORS.INVALID_PARAMS, "params.businessId has invalid format");
  }

  const contextId = (typeof params.contextId === "string" ? params.contextId : null) ?? randomUUID();
  const mock = isAndreaniMockActive(businessId);

  // Guard: shipment.quote requires both postal codes — surface a clear -32602
  // instead of letting dispatchSkill throw and bubble up as opaque -32603.
  if (skill === "shipment.quote") {
    const origin = requireString(params, "originPostalCode");
    const destination = requireString(params, "destinationPostalCode");
    if (!origin) {
      return rpcError(body.id, RPC_ERRORS.INVALID_PARAMS,
        "params.originPostalCode is required — configure el código postal del negocio");
    }
    if (!destination) {
      return rpcError(body.id, RPC_ERRORS.INVALID_PARAMS,
        "params.destinationPostalCode is required — indicá el código postal de destino");
    }
  }

  try {
    const result = await dispatchSkill(skill, params, businessId, mock);
    // Cero Humo: in mock mode, prepend an unmissable sandbox notice. The result
    // payload is kept in the SAME text part (JSON) because sendStructured
    // surfaces parts-text OR the result field, never both — a notice-only part
    // would drop the tracking/cost data the Supervisor needs to relay.
    const parts = mock
      ? [
          {
            kind: "text" as const,
            text:
              "⚠️ Respuesta SIMULADA (modo sandbox Andreani) — el tracking y los costos no son reales.\n" +
              JSON.stringify(result),
          },
        ]
      : undefined;
    return rpcResult(body.id, {
      kind: "message", messageId: randomUUID(),
      role: "agent", contextId, skill, result, mock,
      ...(parts !== undefined ? { parts } : {}),
    });
  } catch (err) {
    cloudLog({ severity: "ERROR", component: "A2A", action: "ANDREANI_RPC_DISPATCH_ERROR",
      a2a_transfer: false, message: `Andreani skill ${skill} threw`,
      data: { skill, businessId, error: err instanceof Error ? err.message : String(err) } });
    return rpcError(body.id, RPC_ERRORS.INTERNAL_ERROR, `skill ${skill} failed`);
  }
}

async function dispatchSkill(
  skill: string,
  params: Record<string, unknown>,
  businessId: string,
  mock: boolean,
): Promise<unknown> {

  if (skill === "shipment.quote") {
    const rawWeight = requireNumber(params, "weightGrams");
    if (rawWeight === null) {
      cloudLog({
        severity: "WARNING", component: "A2A", action: "ANDREANI_WEIGHT_FALLBACK",
        a2a_transfer: false,
        message: "shipment.quote called without weightGrams — defaulting to 500 g",
        data: { businessId, skill, defaultedTo: 500 },
      });
    }
    const input: QuoteInput = {
      originPostalCode: requireString(params, "originPostalCode") ?? "",
      destinationPostalCode: requireString(params, "destinationPostalCode") ?? "",
      weightGrams: rawWeight ?? 500,
      declaredValue: requireNumber(params, "declaredValue") ?? 0,
    };
    if (!input.originPostalCode || !input.destinationPostalCode) {
      throw new Error("originPostalCode and destinationPostalCode are required");
    }
    return mock ? mockShipmentQuote(input) : shipmentQuote(input, businessId);
  }

  if (skill === "shipment.create") {
    const rawWeight = requireNumber(params, "weightGrams");
    const saleId = requireString(params, "saleId") ?? "";
    if (rawWeight === null) {
      cloudLog({
        severity: "WARNING", component: "A2A", action: "ANDREANI_WEIGHT_FALLBACK",
        a2a_transfer: false,
        message: "shipment.create called without weightGrams — defaulting to 500 g",
        data: { businessId, saleId, skill, defaultedTo: 500 },
      });
    }
    const customer = params.customer && typeof params.customer === "object"
      ? params.customer as Record<string, unknown>
      : {};
    const input: CreateShipmentInput = {
      saleId,
      customer: {
        name: typeof customer.name === "string" ? customer.name : "",
        address: typeof customer.address === "string" ? customer.address : "",
        postalCode: typeof customer.postalCode === "string" ? customer.postalCode : "",
        phone: typeof customer.phone === "string" ? customer.phone : "",
        dni: typeof customer.dni === "string" && customer.dni.trim() ? customer.dni.trim() : null,
      },
      service: (() => {
        const VALID_SERVICES = new Set<string>(["sucursal", "domicilio", "express"]);
        const rawService = requireString(params, "service") ?? "domicilio";
        return (VALID_SERVICES.has(rawService) ? rawService : "domicilio") as CreateShipmentInput["service"];
      })(),
      weightGrams: rawWeight ?? 500,
    };
    if (!input.saleId) throw new Error("saleId is required for shipment.create");
    return mock
      ? mockShipmentCreate(input, businessId)
      : shipmentCreate(input, businessId);
  }

  if (skill === "shipment.track") {
    const input: TrackInput = {
      trackingNumber: requireString(params, "trackingNumber") ?? "",
    };
    if (!input.trackingNumber) throw new Error("trackingNumber is required for shipment.track");
    return mock ? mockShipmentTrack(input) : shipmentTrack(input, businessId);
  }

  throw new Error(`unknown skill: ${skill}`);
}
