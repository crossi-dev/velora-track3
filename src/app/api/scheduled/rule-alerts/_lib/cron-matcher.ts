// Cron expression matcher for time-based BusinessRules. Cloud Scheduler
// fires every 5 minutes, so the minute field is matched within a 5-min
// window — a rule with `30 9 * * *` fires when the run lands on a slot
// covering minute 30 (i.e. 9:30 ART, regardless of whether Scheduler
// fired at 9:30:00 or 9:30:42).
//
// Catch-up runs replay every slot between `lastRunAt` and "now" so a
// late or missed Scheduler tick still triggers the rule. Idempotency at
// the ChatMessage level (clientMessageId per rule+slot+employee) makes
// overlapping replays safe.
//
// cron-parser (v5, github.com/harrisiirak/cron-parser) is used for the
// canonical expression evaluator. The library handles timezone-aware
// iteration (including DST — though ART has none) and supports the full
// cron field syntax that the hand-rolled matcher supported.

import { CronExpressionParser } from "cron-parser";

export const SLOT_MINUTES = 5;
const ART_TIME_ZONE = "America/Argentina/Buenos_Aires";

export interface SlotInstant {
  slotKey: string;
  hourART: number;
  minuteART: number;
  dowART: number;
}

// Stable Intl formatter for ART. We read each field by name from
// formatToParts so the implementation is independent of the host's
// locale defaults.
const ART_PARTS_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: ART_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  weekday: "short",
});

const DOW_BY_WEEKDAY: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

interface ARTFields {
  year: string;
  month: string;
  day: string;
  hourART: number;
  minuteART: number;
  dowART: number;
}

function readARTFields(when: Date): ARTFields {
  const parts = ART_PARTS_FORMATTER.formatToParts(when);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? "";
  // Intl returns "24" instead of "00" for midnight when hour12=false and
  // hourCycle is unspecified; normalize so slotKey/hour math stays sane.
  const hourRaw = parseInt(get("hour"), 10);
  const hourART = Number.isFinite(hourRaw) ? hourRaw % 24 : 0;
  const minuteART = parseInt(get("minute"), 10) || 0;
  const dowART = DOW_BY_WEEKDAY[get("weekday")] ?? 0;
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hourART,
    minuteART,
    dowART,
  };
}

/**
 * Compute the canonical 5-minute slot for a given UTC instant in ART.
 * Two instants in the same 5-min window produce the same slotKey, which
 * keeps idempotency rock-solid. ART fields come from Intl with a fixed
 * IANA zone (America/Argentina/Buenos_Aires) — never offset arithmetic.
 */
export function slotFromInstant(when: Date): SlotInstant {
  const { year, month, day, hourART, minuteART, dowART } = readARTFields(when);
  const slotMinute = Math.floor(minuteART / SLOT_MINUTES) * SLOT_MINUTES;
  const slotKey =
    `${year}-${month}-${day}T` +
    `${String(hourART).padStart(2, "0")}:${String(slotMinute).padStart(2, "0")}`;
  return { slotKey, hourART, minuteART: slotMinute, dowART };
}

/**
 * Iterate every 5-minute slot between `from` (exclusive) and `to`
 * (inclusive). Used to replay slots missed since the last successful run.
 */
export function slotsBetween(from: Date, to: Date): SlotInstant[] {
  const slots: SlotInstant[] = [];
  // Snap `from` up to the next slot boundary so we never re-emit `from`'s slot.
  const fromMs = from.getTime();
  const toMs = to.getTime();
  const stepMs = SLOT_MINUTES * 60_000;
  let cursor = Math.floor(fromMs / stepMs) * stepMs + stepMs;
  while (cursor <= toMs) {
    slots.push(slotFromInstant(new Date(cursor)));
    cursor += stepMs;
  }
  return slots;
}

/**
 * Returns true if the cron expression fires at the ART slot identified by
 * `slotKey` (format: "YYYY-MM-DDTHH:MM" in ART / America/Argentina/Buenos_Aires).
 *
 * Uses `cron-parser` for timezone-aware evaluation. The match condition is:
 * the next scheduled occurrence after (slotStart - 1ms) falls within the
 * 5-minute window [slotStart, slotStart + 5min).
 *
 * Day-of-month (field 3) and month (field 4): non-wildcard values are REJECTED
 * to preserve the existing contract (see `matchesCronExpression` docs).
 *
 * This function is the canonical replacement for the hand-rolled evaluator.
 * `matchesCronExpression` delegates to it via `slot.slotKey`.
 */
export function matchesCronExpressionWithParser(
  cronExpr: string,
  slotKey: string,
): boolean {
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length < 5) return false;

  // Preserve rejection contract: non-wildcard DOM or month are unsupported.
  if (parts[2] !== "*" || parts[3] !== "*") return false;

  // Parse slotKey ("YYYY-MM-DDTHH:MM") as an ART instant.
  // ART = UTC-3, no DST — appending the fixed offset is reliable.
  const slotStart = new Date(`${slotKey}:00.000-03:00`);
  if (isNaN(slotStart.getTime())) return false;

  const slotEnd = new Date(slotStart.getTime() + SLOT_MINUTES * 60_000);

  try {
    const expr = CronExpressionParser.parse(cronExpr, {
      tz: ART_TIME_ZONE,
      // currentDate is 1ms before the slot window so .next() is the first
      // occurrence AT OR AFTER slotStart.
      currentDate: new Date(slotStart.getTime() - 1),
    });
    const next = expr.next().toDate();
    return next >= slotStart && next < slotEnd;
  } catch {
    return false;
  }
}

// Reference week anchored to a known Monday (2024-01-15 = Mon dow=1) in ART.
// Used to reconstruct a plausible ISO date string for slots that carry only
// numeric time fields (hourART, minuteART, dowART) without a real calendar date
// in their slotKey. ART = UTC-3, no DST — ISO 8601 date math is safe here.
const REFERENCE_MONDAY_ART = "2024-01-15"; // dow=1 (Monday)

/**
 * Reconstruct a `YYYY-MM-DDTHH:MM` slotKey in ART from the numeric slot fields.
 * The date is derived by offsetting from a fixed reference Monday so that
 * `dowART` maps to the correct weekday. This is used when `slot.slotKey` is
 * not a parseable date (e.g. the synthetic `"test"` string in unit tests).
 */
function syntheticSlotKey(hourART: number, minuteART: number, dowART: number): string {
  // Reference Monday midnight ART = 2024-01-15T00:00-03:00 = 2024-01-15T03:00Z.
  // Add 3h to the ART midnight UTC base so getUTCDate()/Month()/FullYear()
  // read the ART calendar date, not the UTC date (which lags by 3h).
  const refMidnightUtcMs = new Date(`${REFERENCE_MONDAY_ART}T00:00:00-03:00`).getTime();
  const artMidnightUtcMs = refMidnightUtcMs + (dowART - 1) * 86_400_000;
  const artCalendarDate = new Date(artMidnightUtcMs + 3 * 3_600_000);
  const yyyy = String(artCalendarDate.getUTCFullYear());
  const mo = String(artCalendarDate.getUTCMonth() + 1).padStart(2, "0");
  const da = String(artCalendarDate.getUTCDate()).padStart(2, "0");
  const hh = String(hourART).padStart(2, "0");
  const mm = String(minuteART).padStart(2, "0");
  return `${yyyy}-${mo}-${da}T${hh}:${mm}`;
}

/**
 * Returns true if the cron expression fires at the given ART slot.
 * Supports: wildcard, step (every-N), single values, N-M ranges, a,b,c
 * lists for all five standard cron fields.
 *
 * Delegates to `matchesCronExpressionWithParser` using `slot.slotKey`
 * (which encodes the full ART date and time) so that cron-parser can
 * evaluate the expression with proper timezone anchoring.
 *
 * When `slot.slotKey` is not a parseable ISO date (e.g. the synthetic
 * `"test"` string used in unit-test helpers), the slot is reconstructed
 * from `hourART`/`minuteART`/`dowART` against a fixed reference week.
 *
 * Day-of-month (field 3) and month (field 4): if either contains a
 * non-wildcard value we REJECT the expression rather than silently
 * ignoring it. Cloud Scheduler would fire on wrong days/months, and
 * accepting that would be a correctness bug. Use "*" for both if the
 * rule should fire on every day/month.
 */
export function matchesCronExpression(cronExpr: string, slot: SlotInstant): boolean {
  // Prefer the real slotKey; fall back to a synthetic one for unit-test slots
  // that carry `slotKey: "test"` or any other non-parseable string.
  const parsedFromKey = new Date(`${slot.slotKey}:00.000-03:00`);
  const key = isNaN(parsedFromKey.getTime())
    ? syntheticSlotKey(slot.hourART, slot.minuteART, slot.dowART)
    : slot.slotKey;
  return matchesCronExpressionWithParser(cronExpr, key);
}
