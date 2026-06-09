// Helpers compartidos por los handlers supervisor-internal para envolver
// cualquier escritura directa a Prisma con beginIdempotentMutation +
// recordCriticalWriteEvent. Mantienen los handlers (rule/policy/setup/
// broadcast/employee) bajo el hard limit de 300 LOC sin duplicar el patrón.

import { createHash } from "crypto";
import { prisma } from "@/lib/prisma";
import { reportWarning } from "@/lib/cloud-logger";
import { recordCriticalWriteEvent } from "@/infrastructure/shared/critical-write-audit";
import {
  beginIdempotentMutation,
  completeIdempotentMutation,
  releaseIdempotentMutation,
} from "@/app/api/_lib/idempotency";
import { assertDemoQuota, DemoLimitReachedError } from "@/app/api/_lib/demo-quota";

export { isValidCronExpression } from "@/domain/rules/cron-validation";

export function deriveSupervisorIdempotencyKey(
  seed: string,
  intent: string,
  data: unknown,
): string {
  return createHash("sha256")
    .update(`${seed}|${intent}|${JSON.stringify(data ?? null)}`)
    .digest("hex");
}

export type GuardedResult<T> = { value: T } | { skipped: true } | { demoLimitReached: true; message: string };

/** Type guard: true when the quota was reached and the write was blocked. */
export function isDemoLimitReached<T>(r: GuardedResult<T>): r is { demoLimitReached: true; message: string } {
  return "demoLimitReached" in r;
}

/**
 * Envuelve una mutación supervisor-internal con la pareja idempotency +
 * critical-write-audit. El handler que llama provee el closure `exec`
 * con la escritura concreta a Prisma y un `summaryFor` que produce la
 * carga de audit a partir del resultado del exec.
 *
 * Si la clave de idempotencia matchea un request previo, retorna
 * `{ skipped: true }` y NO ejecuta `exec` — el caller debe interpretar
 * eso como "ya se hizo, no hay error".
 */
export async function withSupervisorContractGuards<T>(args: {
  actionType: string;
  routeScope: string;
  resourceType: string;
  businessId: string;
  actorUserId: string;
  idempotencyKey: string;
  requestBody: unknown;
  summaryFor: (result: T) => { summary: string; resourceId: string | null; payload: unknown };
  exec: () => Promise<T>;
}): Promise<GuardedResult<T>> {
  const idempotency = await beginIdempotentMutation({
    client: prisma,
    businessId: args.businessId,
    actionType: args.actionType,
    idempotencyKey: args.idempotencyKey,
    requestBody: args.requestBody,
  });
  if (idempotency.kind !== "execute") return { skipped: true };
  const recordId = idempotency.recordId;

  // Quota checked after begin so replays of already-counted actions are never blocked.
  try {
    await assertDemoQuota(args.businessId);
  } catch (e) {
    if (e instanceof DemoLimitReachedError) {
      await releaseIdempotentMutation({ client: prisma, recordId });
      return { demoLimitReached: true, message: e.message };
    }
    throw e;
  }

  try {
    const value = await args.exec();
    const meta = args.summaryFor(value);
    try {
      await recordCriticalWriteEvent({
        client: prisma,
        businessId: args.businessId,
        actorUserId: args.actorUserId,
        actorEmployeeId: null,
        routeScope: args.routeScope,
        actionType: args.actionType,
        resourceType: args.resourceType,
        resourceId: meta.resourceId,
        summary: meta.summary,
        payload: meta.payload,
      });
    } catch (err) {
      reportWarning("[supervisor-contract-helpers] audit write failed", {
        actionType: args.actionType,
        businessId: args.businessId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    await completeIdempotentMutation({
      client: prisma,
      recordId,
      responseStatus: 200,
      responseBody: { ok: true },
    });
    return { value };
  } catch (err) {
    await releaseIdempotentMutation({ client: prisma, recordId });
    throw err;
  }
}
