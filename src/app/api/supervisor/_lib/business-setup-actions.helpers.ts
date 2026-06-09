// Internal helpers for business-setup-actions.ts.
// Split out to keep that file under 300 LOC.
// These are module-private utilities — not part of the public API.

import { prisma } from "@/lib/prisma";
import { getServerActionMeta } from "@/app/api/_lib/mutation-contract";
import {
  deriveSupervisorIdempotencyKey as deriveIdempotencyKey,
  withSupervisorContractGuards as withContractGuards,
  isDemoLimitReached,
} from "./contract-helpers";
import { invalidateSupervisorContext } from "./load-context";
import type { BusinessSetupField } from "./business-setup-actions";

const SETUP_UPDATE_ACTION = getServerActionMeta("business-setup.update");

export function asObject(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}

export function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

export function normalizePaymentMethods(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const cleaned = value
    .map((v) => (typeof v === "string" ? v.trim() : ""))
    .filter((v): v is string => v.length > 0);
  // Dedup preservando orden.
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const m of cleaned) {
    const key = m.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(m);
  }
  return deduped;
}

export function coerceCash(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === "string") {
    const cleaned = value.replace(/[^\d.,-]/g, "").replace(/\./g, "").replace(",", ".");
    const parsed = Number(cleaned);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return null;
}

export async function persistSetupField(args: {
  businessId: string;
  actorUserId: string;
  idempotencySeed: string;
  field: BusinessSetupField;
  payload: Record<string, unknown>;
  data: Record<string, unknown>;
}): Promise<"persisted" | "skipped"> {
  // Idempotency key includes only the field name, NOT the value.
  // Rationale: two concurrent updates for the same field within the same
  // idempotencySeed must deduplicate — last-write-wins non-determinism is
  // worse than deduplication. If the owner genuinely wants to change a field
  // twice in the same turn, a new idempotencySeed (next turn) allows it.
  const idempotencyKey = deriveIdempotencyKey(args.idempotencySeed, "update_business_setup", { field: args.field });
  const guarded = await withContractGuards({
    actionType: SETUP_UPDATE_ACTION.actionType,
    routeScope: SETUP_UPDATE_ACTION.routeScope,
    resourceType: SETUP_UPDATE_ACTION.resourceType,
    businessId: args.businessId,
    actorUserId: args.actorUserId,
    idempotencyKey,
    requestBody: { field: args.field, ...args.data },
    summaryFor: () => ({
      summary: `Business setup: ${args.field}`,
      resourceId: args.businessId,
      payload: { field: args.field, ...args.data },
    }),
    exec: async () => {
      await prisma.business.update({ where: { id: args.businessId }, data: args.payload });
      invalidateSupervisorContext(args.businessId);
    },
  });
  if (isDemoLimitReached(guarded)) return "skipped"; // quota blocked; treated as no-op for setup
  return "skipped" in guarded ? "skipped" : "persisted";
}
