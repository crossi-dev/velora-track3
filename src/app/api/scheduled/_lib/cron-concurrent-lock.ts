// Lease-based concurrent-run guard for scheduled cron handlers.
//
// Cloud Scheduler fires at-least-once (https://cloud.google.com/scheduler/docs/at-least-once).
// Cloud Run can run multiple instances concurrently (https://cloud.google.com/run/docs/concurrency).
// Together, a slow run can race its own next tick, producing duplicate processing.
//
// Pattern — atomic lease acquire via updateMany:
//   1. updateMany WHERE runningAt IS NULL OR runningAt < (now - LEASE_TTL_MS) → count.
//   2. count === 0  → another instance holds the lease → caller returns 200 skipped.
//   3. count === 1  → we hold the lease → caller runs body in try/finally.
//   4. finally: release via releaseCronLease (clears runningAt).
//   5. Crash recovery: stale-lease check on the next tick reclaims automatically.
//
// Uses existing CronCheckpoint model (jobName @id, runningAt DateTime?).
// No new model or migration needed.

import { prisma } from "@/lib/prisma";
import { cloudLog } from "@/lib/cloud-logger";

export interface AcquireResult {
  acquired: boolean;
}

/**
 * Try to acquire a lease for `cronName`.
 * Returns `{ acquired: true }` if this instance now holds the lease,
 * or `{ acquired: false }` if another instance already does.
 *
 * The caller MUST call `releaseCronLease` in a `finally` block when `acquired` is true.
 */
export async function acquireCronLease(
  cronName: string,
  leaseTtlMs: number,
): Promise<AcquireResult> {
  const now = new Date();
  const staleThreshold = new Date(now.getTime() - leaseTtlMs);

  // Ensure the row exists before attempting the atomic update.
  // upsert with runningAt: null only if the row doesn't exist yet.
  await prisma.cronCheckpoint.upsert({
    where: { jobName: cronName },
    create: { jobName: cronName, lastRunAt: now, runningAt: null },
    update: {},
  });

  // Atomic acquire: only succeeds if runningAt is null or stale.
  const result = await prisma.cronCheckpoint.updateMany({
    where: {
      jobName: cronName,
      OR: [
        { runningAt: null },
        { runningAt: { lt: staleThreshold } },
      ],
    },
    data: { runningAt: now },
  });

  if (result.count === 0) {
    cloudLog({
      severity: "INFO",
      component: "System",
      action: "CRON_LOCK_SKIP",
      a2a_transfer: false,
      message: `${cronName}: skipped — another instance holds the lease`,
      data: { event: "cron_lock.skip", cronName },
    });
    return { acquired: false };
  }

  return { acquired: true };
}

/**
 * Release the lease acquired by `acquireCronLease`.
 * Safe to call in `finally` — swallows errors (lock expires naturally after TTL).
 */
export async function releaseCronLease(cronName: string): Promise<void> {
  await prisma.cronCheckpoint
    .updateMany({
      where: { jobName: cronName },
      data: { runningAt: null },
    })
    .catch(() => {
      /* non-fatal — lease expires after TTL on its own */
    });
}
