import { prisma } from "@/lib/prisma";
import { recordCriticalWriteEvent } from "@/infrastructure/shared/critical-write-audit";
import { getServerActionMeta } from "@/app/api/_lib/mutation-contract";
import type { ImportType } from "./import-validation";

/**
 * Single call site for the import.create critical-write audit event.
 * The route guardrail expects exactly ONE recordCriticalWriteEvent in this
 * route tree, so keep this the only place that invokes it.
 */
export async function auditImportCompleted(params: {
  actorUserId: string;
  businessId: string;
  action: ReturnType<typeof getServerActionMeta>;
  type: ImportType;
  bufferHash: string;
  imported: number;
  skipped: number;
  rowCount: number;
}): Promise<void> {
  const { actorUserId, businessId, action, type, bufferHash, imported, skipped, rowCount } = params;

  await recordCriticalWriteEvent({
    client: prisma,
    businessId,
    actorUserId,
    routeScope: action.routeScope,
    actionType: action.actionType,
    resourceType: action.resourceType,
    resourceId: `${type}:${bufferHash.slice(0, 16)}`,
    summary: `Importación ${type} completada`,
    payload: {
      type,
      imported,
      skipped,
      rowCount,
    },
  });
}
