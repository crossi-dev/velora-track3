// Computes the day's sales / expenses / net for the cash-movement ledger.
//
// "Today" is the calendar day in America/Argentina/Buenos_Aires (UTC-3, no DST).
// The boundary is computed via Intl.DateTimeFormat — see src/lib/argentina-date.ts
// for the shared implementation. Re-exported here so existing dashboard imports
// continue to work without change.

import type { CashMovement } from "./types";
import {
  getArgentinaDateString,
  getArgentinaDayBounds,
} from "@/lib/argentina-date";

export { getArgentinaDateString, getArgentinaDayBounds };

export interface TodaySummary {
  sales: number;
  expenses: number;
  net: number;
  hasMovements: boolean;
}

export function computeTodaySummary(
  movements: CashMovement[],
  nowMs: number = Date.now(),
): TodaySummary {
  const todayAR = getArgentinaDateString(nowMs);

  let sales = 0;
  let expenses = 0;
  let hasMovements = false;

  for (const movement of movements) {
    if (!movement?.date) continue;
    const movementMs = new Date(movement.date).getTime();
    if (!Number.isFinite(movementMs)) continue;
    if (getArgentinaDateString(movementMs) !== todayAR) continue;

    hasMovements = true;

    const amount = Number(movement.amount);
    if (!Number.isFinite(amount)) continue;

    if (movement.type === "sale" || movement.type === "income") {
      sales += amount;
    } else if (movement.type === "adjustment") {
      // Cash adjustments affect the net in both directions:
      // positive adjustment → more cash in the till (add to sales so net increases),
      // negative adjustment → cash removed (add to expenses so net decreases).
      if (amount >= 0) {
        sales += amount;
      } else {
        expenses += Math.abs(amount);
      }
    } else if (amount < 0) {
      expenses += Math.abs(amount);
    }
  }

  return {
    sales,
    expenses,
    net: sales - expenses,
    hasMovements,
  };
}
