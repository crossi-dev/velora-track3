// Pure helpers extracted from oca-adapter.ts to keep that file under 300 LOC.
//
// Exports:
//   - ocaResult  — wraps a successful skill result in the canonical JsonRpcResponse shape
//   - ocaError   — wraps a JSON-RPC error response
//   - str        — typed param extractor for string fields
//   - num        — typed param extractor for numeric fields

import { randomUUID } from "crypto";
import type { JsonRpcResponse } from "../logistica-provider";

export function ocaResult(skill: string, data: unknown): JsonRpcResponse {
  const callId = randomUUID();
  return {
    jsonrpc: "2.0",
    id: callId,
    result: {
      kind: "message",
      messageId: randomUUID(),
      role: "agent",
      contextId: callId,
      skill,
      parts: [{ kind: "text" as const, text: JSON.stringify(data) }],
      result: data,
    },
  };
}

export function ocaError(code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id: null, error: { code, message } };
}

export function str(params: Record<string, unknown>, key: string): string {
  const v = params[key];
  return typeof v === "string" && v.trim() ? v.trim() : "";
}

export function num(params: Record<string, unknown>, key: string, fallback: number): number {
  const v = params[key];
  return typeof v === "number" && isFinite(v) ? v : fallback;
}

/**
 * Returns true when `err` is a Prisma P2002 unique-constraint violation.
 * Used by OcaAdapter.create() to detect a concurrent insert on saleId.
 */
export function isPrismaP2002(err: unknown): boolean {
  return err instanceof Error && "code" in err && (err as Record<string, unknown>).code === "P2002";
}

// ── Shipment persistence helpers ──────────────────────────────────────────────
// Extracted from OcaAdapter.create() to keep oca-adapter.ts under 300 LOC.

import { cloudLog } from "@/lib/cloud-logger";
import { prisma } from "@/lib/prisma";
import type { OcaCreateResult } from "@/app/api/agents/oca/_lib/types";

/**
 * Persists an OCA shipment atomically (create, not upsert).
 * On P2002 (concurrent insert won the race), fetches the winning row and returns it.
 * Returns null when the local `result` should be returned (happy path or non-P2002 fail).
 */
export async function persistOcaShipment(
  result: OcaCreateResult,
  businessId: string,
  operativa: string,
): Promise<OcaCreateResult | null> {
  const { saleId } = result;
  try {
    await prisma.ocaShipment.create({
      data: {
        businessId,
        saleId,
        trackingNumber: result.trackingNumber,
        operativa,
        service:  result.service,
        status:   "created",
        labelUrl: result.labelUrl,
        events:   [],
      },
    });
    cloudLog({
      severity: "INFO", component: "A2A", action: "OCA_SHIPMENT_PERSISTED",
      a2a_transfer: false,
      message: `OCA shipment persisted: trackingNumber=${result.trackingNumber} saleId=${saleId}`,
      data: { businessId, saleId, trackingNumber: result.trackingNumber },
    });
    return null; // happy path — caller returns local result
  } catch (createErr) {
    // P2002 = concurrent insert; return the winning row.
    if (isPrismaP2002(createErr)) {
      const race = await prisma.ocaShipment.findFirst({
        where: { saleId, businessId },
        select: { trackingNumber: true, service: true, labelUrl: true },
      });
      if (race) {
        cloudLog({
          severity: "WARNING", component: "A2A", action: "OCA_CREATE_RACE_RESOLVED",
          a2a_transfer: false,
          message: `OCA create race — returning winning row for saleId=${saleId}`,
          data: { businessId, saleId, trackingNumber: race.trackingNumber },
        });
        return { saleId, trackingNumber: race.trackingNumber, labelUrl: race.labelUrl, estimatedDelivery: null, service: race.service, provider: "oca" };
      }
    }
    // Non-fatal (non-P2002): OCA order exists at OCA; log and fall through.
    cloudLog({
      severity: "ERROR", component: "A2A", action: "OCA_SHIPMENT_PERSIST_FAILED",
      a2a_transfer: false,
      message: `OCA shipment created at OCA but DB persist failed for saleId=${saleId}`,
      data: { businessId, saleId, error: createErr instanceof Error ? createErr.message : String(createErr) },
    });
    return null;
  }
}
