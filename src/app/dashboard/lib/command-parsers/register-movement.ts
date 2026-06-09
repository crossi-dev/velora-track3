import { tLang } from "../DashboardLangContext";
import type { MovementType, RegisterMovementData, VeloraSingleCommand } from "./shared";
import { parseARAmount } from "@/lib/parse-ar-amount";

export type { MovementType, RegisterMovementData };

// Keyword groups. Presence of a more specific category (tax, salary)
// overrides the generic purchase/income verb categorization so
// "pagué sueldos 50000" becomes "salary" not "purchase".
const TAX_TOKENS = /\b(?:impuesto|afip|iva|ganancias|ingresos\s+brutos|iibb|monotributo)\b/;
const SALARY_TOKENS = /\b(?:sueldo|sueldos|salario|salarios)\b/;
const ADJUSTMENT_TOKENS = /\b(?:ajuste|diferencia|caja\s+mal)\b/;

// Expense and income verbs — ordered alternations used inside the main
// patterns below. Kept narrow to avoid false positives from unrelated
// conversation ("le cobre" / "te gané" would not match).
// Amount token pattern — accepts AR-peso formats: plain digits, "5.000",
// "5,000", "5.000,50", "$5.000", "5k". Replaces the old \d{1,9} that
// silently dropped thousands-separator inputs like "$5.000".
const AMOUNT_TOKEN = String.raw`\$?\s*(\d[\d.,]*(?:[kK])?)`;

const EXPENSE_PATTERNS: RegExp[] = [
  // "anotá / registrá (un) gasto de 5000 en luz" (request-prefixed)
  new RegExp(
    `^(?:anota(?:le|me)?|anota|registra(?:le|me)?|registra|apunta(?:le|me)?|apunta)\\s+(?:un\\s+)?(?:gasto|pago|compra)\\s+(?:de\\s+)?${AMOUNT_TOKEN}\\s*(?:pesos?)?\\s*(?:en|por|de|para)\\s+(.+?)\\??$`,
  ),
  // "gasto / gasté / pagué / compré 3000 en/por/de luz"
  new RegExp(
    `^(?:gaste|gast\\u00e9|gasto|pague|pag\\u00f3|pagu\\u00e9|pago|compre|compr\\u00e9)\\s+(?:de\\s+)?${AMOUNT_TOKEN}\\s*(?:pesos?)?\\s*(?:en|por|de|para)\\s+(.+?)\\??$`,
  ),
  // "pagué alquiler 8000" / "compré mercadería por 20000" (description first, amount last)
  new RegExp(
    `^(?:pague|pagu\\u00e9|compre|compr\\u00e9|pago)\\s+(.+?)\\s+(?:por\\s+)?${AMOUNT_TOKEN}\\s*(?:pesos?)?\\s*$`,
  ),
];

const INCOME_PATTERNS: RegExp[] = [
  // "anotá / registrá (un) ingreso de 15000 de servicio"
  new RegExp(
    `^(?:anota(?:le|me)?|anota|registra(?:le|me)?|registra|apunta(?:le|me)?|apunta)\\s+(?:un\\s+)?(?:ingreso|cobro|entrada)\\s+(?:de\\s+)?${AMOUNT_TOKEN}\\s*(?:pesos?)?\\s*(?:en|por|de|para)\\s+(.+?)\\??$`,
  ),
  // "cobré / ingreso / entrada 15000 de/por/en servicio"
  new RegExp(
    `^(?:cobre|cobr\\u00e9|cobro|ingreso|ingrese|ingres\\u00e9|entrada)\\s+(?:de\\s+)?${AMOUNT_TOKEN}\\s*(?:pesos?)?\\s*(?:en|por|de|para)\\s+(.+?)\\??$`,
  ),
  // "cobré servicio 15000" (description first, amount last)
  new RegExp(
    `^(?:cobre|cobr\\u00e9|cobro)\\s+(.+?)\\s+(?:por\\s+)?${AMOUNT_TOKEN}\\s*(?:pesos?)?\\s*$`,
  ),
];

// Returns [amount, description] or null. Order of the capture groups
// differs between patterns ("amount first" vs "description first"), so
// the helper accepts a `amountFirst` flag per pattern.
// Uses parseARAmount so "$5.000", "5k", "5.000,50" are all handled.
function tryPatterns(
  normalized: string,
  patterns: RegExp[],
  amountFirst: boolean,
): { amount: number; description: string } | null {
  for (const pattern of patterns) {
    const m = normalized.match(pattern);
    if (!m) continue;
    const amountStr = amountFirst ? m[1] : m[2];
    const description = amountFirst ? m[2] : m[1];
    const amount = parseARAmount(amountStr ?? "");
    if (amount === null) continue;
    const trimmed = description?.trim() ?? "";
    if (!trimmed || trimmed.length < 2) continue;
    return { amount, description: trimmed };
  }
  return null;
}

// Category keywords (impuesto / sueldo / ajuste / etc.) override the
// generic purchase/income verb regardless of where they appear in the
// input — verb zone OR description. Examples:
//   "pagué sueldos 50000"        → "salary" (keyword in verb zone)
//   "pagué 15000 de impuesto"    → "tax"    (keyword in description)
//   "pagué 3000 de iva"          → "tax"
function categorize(normalized: string, fallback: MovementType): MovementType {
  if (TAX_TOKENS.test(normalized)) return "tax";
  if (SALARY_TOKENS.test(normalized)) return "salary";
  if (ADJUSTMENT_TOKENS.test(normalized)) return "adjustment";
  return fallback;
}

export function detectRegisterMovement(normalized: string): VeloraSingleCommand | null {
  // Try amount-first expense patterns (first 2 of the 3)
  const expenseAmountFirst = tryPatterns(normalized, EXPENSE_PATTERNS.slice(0, 2), true);
  if (expenseAmountFirst) {
    return {
      matched: true,
      intent: "register_movement",
      data: {
        movementType: categorize(normalized, "purchase"),
        amount: expenseAmountFirst.amount,
        description: expenseAmountFirst.description,
      },
    };
  }
  const expenseDescFirst = tryPatterns(normalized, EXPENSE_PATTERNS.slice(2), false);
  if (expenseDescFirst) {
    return {
      matched: true,
      intent: "register_movement",
      data: {
        movementType: categorize(normalized, "purchase"),
        amount: expenseDescFirst.amount,
        description: expenseDescFirst.description,
      },
    };
  }
  const incomeAmountFirst = tryPatterns(normalized, INCOME_PATTERNS.slice(0, 2), true);
  if (incomeAmountFirst) {
    return {
      matched: true,
      intent: "register_movement",
      data: {
        movementType: categorize(normalized, "income"),
        amount: incomeAmountFirst.amount,
        description: incomeAmountFirst.description,
      },
    };
  }
  const incomeDescFirst = tryPatterns(normalized, INCOME_PATTERNS.slice(2), false);
  if (incomeDescFirst) {
    return {
      matched: true,
      intent: "register_movement",
      data: {
        movementType: categorize(normalized, "income"),
        amount: incomeDescFirst.amount,
        description: incomeDescFirst.description,
      },
    };
  }
  return null;
}

// Builds the confirmation-card message shown to the user before the
// cash-movement.create action fires. Currency label in ARS.
export function buildRegisterMovementConfirmMessage(
  data: RegisterMovementData,
  currency: string,
): string {
  const fmt = new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: currency || "ARS",
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
  const typeLabel: Record<MovementType, string> = {
    purchase: tLang("Expense", "Gasto"),
    income: tLang("Income", "Ingreso"),
    tax: tLang("Tax", "Impuesto"),
    salary: tLang("Salary", "Sueldo"),
    adjustment: tLang("Adjustment", "Ajuste"),
    // "withdrawal" = sangría / retiro de efectivo de caja. Added 2026-06-03.
    withdrawal: tLang("Cash withdrawal", "Retiro / Sangría"),
  };
  const label = typeLabel[data.movementType].toLowerCase();
  return tLang(
    `Register ${label} of ${fmt.format(data.amount)} for "${data.description}"?`,
    `¿Registrar ${label} de ${fmt.format(data.amount)} por "${data.description}"?`
  );
}
