import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { cloudLog, runWithTraceContext } from "@/lib/cloud-logger";
import { verifyCronSecret } from "@/app/api/_lib/route-helpers";
import {
  matchesCronExpression,
  slotFromInstant,
  slotsBetween,
  SLOT_MINUTES,
  type SlotInstant,
} from "./_lib/cron-matcher";
import {
  fireRuleSlot,
  prepareRule,
  logRuleEvaluated,
  FAN_OUT_WARNING_THRESHOLD,
  type RuleRow,
} from "./_lib/rule-evaluation";

export const maxDuration = 30;

const JOB_NAME = "rule-alerts";
// Cap catch-up replay at 1 hour. Beyond that we'd risk waking up after a
// long outage and spamming employees with stale reminders.
const CATCH_UP_CAP_MS = 60 * 60 * 1000;
// HIGH-3-3: CronLock — how long a runningAt stamp is considered "live".
// Must be < Cloud Scheduler period (5 min) so a crashed run doesn't block forever.
const CRON_LOCK_TTL_MS = 4 * 60 * 1000; // 4 minutes

interface CheckpointResult {
  slots: SlotInstant[];
  slotsCovered: number;
}

async function resolveSlots(now: Date): Promise<CheckpointResult> {
  const checkpoint = await prisma.cronCheckpoint.findUnique({
    where: { jobName: JOB_NAME },
    select: { lastRunAt: true },
  });
  const currentSlot = slotFromInstant(now);
  if (!checkpoint) {
    return { slots: [currentSlot], slotsCovered: 1 };
  }
  const lastRunAt = checkpoint.lastRunAt;
  const earliest = new Date(now.getTime() - CATCH_UP_CAP_MS);
  const from = lastRunAt < earliest ? earliest : lastRunAt;
  const missed = slotsBetween(from, now);
  // Deduplicate the current slot in case slotsBetween already produced it.
  const seen = new Set(missed.map((s) => s.slotKey));
  if (!seen.has(currentSlot.slotKey)) missed.push(currentSlot);
  return { slots: missed, slotsCovered: missed.length };
}

async function evaluateRuleAcrossSlots(
  rule: RuleRow,
  slots: SlotInstant[],
): Promise<{ fired: number; errors: number }> {
  const matchingSlots = slots.filter((slot) => matchesCronExpression(rule.trigger, slot));
  if (matchingSlots.length === 0) return { fired: 0, errors: 0 };

  const prepared = await prepareRule(rule);
  if (!prepared) return { fired: 0, errors: 0 };

  let fired = 0;
  let errors = 0;
  for (const slot of matchingSlots) {
    const result = await fireRuleSlot({ rule, slot, ...prepared });
    fired += result.fired;
    errors += result.errors;
    logRuleEvaluated(rule, slot, result.fired, prepared.employees.length);
  }
  return { fired, errors };
}

/**
 * Evaluates time-based BusinessRules every 5 minutes and writes a ChatMessage
 * for each rule whose cron expression matches the current ART slot.
 *
 * Reliability:
 *  - Catch-up: replays every 5-min slot between the last successful run and
 *    "now" (capped at 1 hour) so a late or missed Cloud Scheduler tick still
 *    triggers the rule. Idempotency at the ChatMessage level keeps replays safe.
 *  - Observability: structured JSON logs at run start/end and per-rule.
 *  - Throttling: bounded concurrency on chat writes (10) and push (5); fan-out
 *    >1000 messages logs a warning so ops can split the rule.
 *
 * Protected by CRON_SECRET via Authorization: Bearer <secret>.
 */
// GET kept for manual/curl verification; POST is the canonical Cloud Scheduler verb.
export async function GET(request: NextRequest) {
  return runWithTraceContext(request.headers, () => handleRequest(request));
}

export async function POST(request: NextRequest) {
  return runWithTraceContext(request.headers, () => handleRequest(request));
}

async function handleRequest(request: NextRequest) {
  const unauth = await verifyCronSecret(request, "rule-alerts");
  if (unauth) return unauth;

  const startedAt = Date.now();
  const now = new Date();

  // HIGH-3-3: CronLock — if runningAt is set and fresh, another instance is
  // already handling this tick. Return 200 immediately to avoid duplicate eval.
  const existingLock = await prisma.cronCheckpoint.findUnique({
    where: { jobName: JOB_NAME },
    select: { runningAt: true },
  });
  if (existingLock?.runningAt && now.getTime() - existingLock.runningAt.getTime() < CRON_LOCK_TTL_MS) {
    cloudLog({
      severity: "INFO",
      component: "System",
      action: "RULE_ALERTS_SKIPPED_LOCKED",
      a2a_transfer: false,
      message: "rule-alerts skipped — another instance holds the lock",
      data: { event: "rule_alerts.skipped_locked", runningAt: existingLock.runningAt.toISOString() },
    });
    return NextResponse.json({ ok: true, skipped: true, reason: "locked" });
  }

  // Acquire lock.
  await prisma.cronCheckpoint.upsert({
    where: { jobName: JOB_NAME },
    create: { jobName: JOB_NAME, lastRunAt: now, runningAt: now },
    update: { runningAt: now },
  });

  cloudLog({
    severity: "INFO",
    component: "System",
    action: "RULE_ALERTS_RUN_STARTED",
    a2a_transfer: false,
    message: "rule-alerts cron run started",
    data: { event: "rule_alerts.run_started", startedAt: now.toISOString() },
  });

  let totalFired = 0;
  let totalErrors = 0;
  let slotsCovered = 0;
  let rules: { id: string; businessId: string; trigger: string; message: string }[] = [];

  try {
    const { slots, slotsCovered: sc } = await resolveSlots(now);
    slotsCovered = sc;
    rules = await prisma.businessRule.findMany({
      where: { active: true, kind: "time-based" },
      select: { id: true, businessId: true, trigger: true, message: true },
    });

    for (const rule of rules) {
      const { fired, errors } = await evaluateRuleAcrossSlots(rule, slots);
      totalFired += fired;
      totalErrors += errors;
    }

    if (totalFired > FAN_OUT_WARNING_THRESHOLD) {
      cloudLog({
        severity: "WARNING",
        component: "System",
        action: "RULE_ALERTS_FAN_OUT_HIGH",
        a2a_transfer: false,
        message: "rule-alerts fan-out exceeded warning threshold",
        data: { event: "rule_alerts.fan_out_high", fired: totalFired, threshold: FAN_OUT_WARNING_THRESHOLD },
      });
    }

    // Persist checkpoint AFTER the run so a crash mid-evaluation replays
    // on the next tick (catch-up + idempotency keeps it safe).
    await prisma.cronCheckpoint.upsert({
      where: { jobName: JOB_NAME },
      create: { jobName: JOB_NAME, lastRunAt: now, runningAt: null },
      update: { lastRunAt: now, runningAt: null },
    });
  } finally {
    // Release lock regardless of success or failure.
    await prisma.cronCheckpoint.updateMany({
      where: { jobName: JOB_NAME, runningAt: now },
      data: { runningAt: null },
    }).catch(() => { /* non-fatal — lock expires naturally after CRON_LOCK_TTL_MS */ });
  }

  const durationMs = Date.now() - startedAt;

  // If every rule evaluation errored and nothing fired, signal Cloud Scheduler
  // to retry the job (Q8 B-2). Partial failures (some fired, some errored) are
  // acceptable — idempotency at the ChatMessage level keeps replays safe.
  const criticalFailure = totalErrors > 0 && totalFired === 0 && rules.length > 0;

  cloudLog({
    severity: criticalFailure ? "ERROR" : "INFO",
    component: "System",
    action: criticalFailure ? "RULE_ALERTS_CRITICAL_FAILURE" : "RULE_ALERTS_RUN_COMPLETED",
    a2a_transfer: false,
    message: criticalFailure
      ? "rule-alerts: all evaluations errored with zero fires — returning 500 for Scheduler retry"
      : "rule-alerts cron run completed",
    data: {
      event: "rule_alerts.run",
      evaluated: rules.length,
      fired: totalFired,
      errors: totalErrors,
      durationMs,
      slotsCovered,
      slotMinutes: SLOT_MINUTES,
      criticalFailure,
    },
  });

  if (criticalFailure) {
    return NextResponse.json(
      { ok: false, evaluated: rules.length, fired: totalFired, errors: totalErrors, durationMs },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    evaluated: rules.length,
    fired: totalFired,
    errors: totalErrors,
    durationMs,
  });
}
