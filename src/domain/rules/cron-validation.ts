// Canonical cron-expression validation helpers for BusinessRule triggers.
// Single source of truth — imported by all 4 sites that previously had local copies:
//   - src/application/use-cases/update-business-rule.use-case.ts
//   - src/application/use-cases/create-business-rule.use-case.ts
//   - src/app/api/supervisor/_lib/contract-helpers.ts
//   - src/app/api/business/business-rules/business-rule-schema.ts

import { matchesCronExpression, slotFromInstant } from "@/app/api/scheduled/rule-alerts/_lib/cron-matcher";

// Known condition-based trigger prefixes — must stay in sync with
// condition-stock-rules.ts and the cron fire path.
const CONDITION_TRIGGER_PREFIXES = ["stock_below:"] as const;

// Validate a single cron field against an allowed integer range.
// Accepts: *, */N, plain integer, N-M range, comma-separated list (including ranges).
// Returns an error string if any value is outside [min, max]; null if valid.
function validateCronField(
  field: string,
  min: number,
  max: number,
  fieldName: string,
): string | null {
  if (field === "*") return null;
  if (field.startsWith("*/")) {
    const n = parseInt(field.slice(2), 10);
    if (!Number.isFinite(n) || n < 1 || n > max) {
      return `time-based trigger: ${fieldName} step "*/N" requires 1 ≤ N ≤ ${max}, got "${field}".`;
    }
    return null;
  }
  const segments = field.split(",");
  for (const seg of segments) {
    if (seg.includes("-")) {
      const [a, b] = seg.split("-").map(Number);
      if (!Number.isFinite(a) || a < min || a > max) {
        return `time-based trigger: ${fieldName} value ${a} out of range [${min}-${max}] in "${field}".`;
      }
      if (!Number.isFinite(b) || b < min || b > max) {
        return `time-based trigger: ${fieldName} value ${b} out of range [${min}-${max}] in "${field}".`;
      }
    } else {
      const v = Number(seg);
      if (!Number.isFinite(v) || v < min || v > max) {
        return `time-based trigger: ${fieldName} value "${seg}" out of range [${min}-${max}] in "${field}".`;
      }
    }
  }
  return null;
}

/**
 * Quick structural check: returns true when `trigger` is a syntactically
 * valid 5-field cron expression (wildcard, step, integer, range, comma-list).
 * Does NOT validate field ranges or day/month constraints.
 * Used by callers that need a boolean gate (e.g. update-business-rule, contract-helpers).
 */
export function isValidCronExpression(trigger: string): boolean {
  const CRON_FIELD_RE = /^(\*|(\*\/[1-9][0-9]*)|\d+(-\d+)?(,\d+(-\d+)*)*)$/;
  const parts = trigger.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  return parts.every((p) => CRON_FIELD_RE.test(p));
}

/**
 * Full validation of a time-based trigger (cron expression).
 * Validates structure (5 fields, day/month must be *) AND field ranges
 * (minute 0-59, hour 0-23, DOW 0-6). Returns an error string or null when valid.
 *
 * Used by callers that need a human-readable error message (e.g. create-business-rule,
 * business-rule-schema PATCH route).
 */
export function validateTimeTrigger(trigger: string): string | null {
  const parts = trigger.trim().split(/\s+/);
  if (parts.length !== 5) {
    return "time-based trigger must be a 5-field cron expression (e.g. \"*/30 * * * *\").";
  }
  if (parts[2] !== "*" || parts[3] !== "*") {
    return "time-based trigger: day-of-month and month fields must be \"*\" (only minute/hour/weekday scheduling is supported).";
  }
  const minuteErr = validateCronField(parts[0], 0, 59, "minute");
  if (minuteErr) return minuteErr;
  const hourErr = validateCronField(parts[1], 0, 23, "hour");
  if (hourErr) return hourErr;
  const dowErr = validateCronField(parts[4], 0, 6, "day-of-week");
  if (dowErr) return dowErr;
  // Surface any remaining runtime errors from the actual matcher.
  matchesCronExpression(trigger, slotFromInstant(new Date()));
  return null;
}

/**
 * Validate a condition-based trigger prefix. Returns an error string or null.
 */
export function validateConditionTrigger(trigger: string): string | null {
  const trimmed = trigger.trim();
  const knownPrefix = CONDITION_TRIGGER_PREFIXES.some((p) => trimmed.startsWith(p));
  if (!knownPrefix) {
    return `condition-based trigger must start with one of: ${CONDITION_TRIGGER_PREFIXES.join(", ")}. Got: "${trimmed.slice(0, 80)}".`;
  }
  return null;
}
