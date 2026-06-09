// Format the daily-summary push payload. Shared between the cron handler
// and any future surface (email, SMS) that might rebroadcast the same data.
//
// Per contract: if there were no sales today, NO message is generated —
// the user opted in to a "ventas del día" digest, not a "cierre contable"
// digest. Days with only expenses are silenced.
import type { CashMovement } from "@/domain";
import { formatMoney as canonicalFormatMoney } from "@/lib/format/money";

// ---------------------------------------------------------------------------
// Prisma Decimal → number conversion + CashMovement row mapping.
// Shared by both the push cron and the chat summary route.
// ---------------------------------------------------------------------------

export type CashMovementRow = {
  id: string;
  type: string;
  amount: number | string | { toNumber?: () => number };
  date: Date;
  description: string;
  saleId: string | null;
};

export function decimalToNumber(value: CashMovementRow["amount"]): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number(value);
  if (value && typeof value === "object" && typeof value.toNumber === "function") {
    return value.toNumber();
  }
  return Number(value);
}

export function rowToCashMovement(row: CashMovementRow): CashMovement {
  return {
    id: row.id,
    type: row.type,
    amount: decimalToNumber(row.amount),
    date: row.date instanceof Date ? row.date.toISOString() : String(row.date),
    description: row.description,
    saleId: row.saleId,
  };
}

// ---------------------------------------------------------------------------
// Money formatting
// ---------------------------------------------------------------------------

export function formatMoney(value: number, currency: string): string {
  // Daily summary style: Intl currency (browser glyph) + rounded + absolute.
  // Re-exported here so existing callers keep the same signature.
  return canonicalFormatMoney(value, currency, {
    style: "intl-currency",
    decimals: 0,
    absoluteValue: true,
  });
}

export interface DailySummaryContentInput {
  sales: number;
  expenses: number;
  net: number;
  businessName: string;
  currency: string;
}

export interface DailySummaryContent {
  title: string;
  body: string;
  url: string;
}

export function formatDailySummaryMessage(
  input: DailySummaryContentInput,
): DailySummaryContent | null {
  if (input.sales <= 0) return null;

  const sales = formatMoney(input.sales, input.currency);
  const url = "/dashboard?tab=sales";
  const title = `Velora · Resumen del día`;

  if (input.expenses <= 0) {
    return {
      title,
      body: `Hoy cobraste ${sales} en ${input.businessName}. ¡Buen día!`,
      url,
    };
  }

  const expenses = formatMoney(input.expenses, input.currency);
  const net = formatMoney(input.net, input.currency);
  const netSign = input.net >= 0 ? "" : "-";

  return {
    title,
    body: `Hoy cobraste ${sales}, gastaste ${expenses}. Neto: ${netSign}${net}.`,
    url,
  };
}
