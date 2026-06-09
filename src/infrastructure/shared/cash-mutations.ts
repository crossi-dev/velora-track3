import type { Prisma } from "@prisma/client";

type CashMovementMutationClient = {
  cashMovement: {
    create: Prisma.TransactionClient["cashMovement"]["create"];
  };
};

// "withdrawal" = sangría / retiro de efectivo de caja (distinct from "adjustment").
// Square: PAID_OUT event; Toast: PAY_OUT entry. Always stored negative (cash leaves drawer).
export type CashMovementType = "purchase" | "tax" | "salary" | "adjustment" | "income" | "sale" | "withdrawal";

// Escritor canónico de CashMovement: las rutas manuales y los flujos compuestos
// pasan por acá para que la normalización de signo y fecha viva en un solo lugar.
export function normalizeCashMovementDescription(value: unknown) {
  if (typeof value !== "string") return "";
  return value.trim();
}

function signCashMovementAmount(type: CashMovementType, amount: number) {
  // Outflows: always stored negative.
  if (type === "purchase" || type === "tax" || type === "salary" || type === "withdrawal") {
    return -Math.abs(amount);
  }

  // Adjustment carries caller-supplied sign (can be positive or negative).
  if (type === "adjustment") {
    return amount;
  }

  // Inflows (sale, income): always stored positive.
  return Math.abs(amount);
}

export async function createCashMovementInTransaction(
  client: CashMovementMutationClient,
  options: {
    businessId: string;
    type: CashMovementType;
    description: string;
    amount: number;
    saleId?: string | null;
    date?: Date;
    // Optional payment method for sale movements ("efectivo" | "qr" | "transferencia" | "tarjeta").
    // Null/undefined for non-sale movements (purchase, tax, salary, etc.).
    paymentMethod?: string | null;
    // Client-supplied idempotency key for standalone (saleId=null) movements.
    // Persisted to enable DB-level dedup via the partial unique index
    // CashMovement_businessId_clientMessageId_key (20260525900000_add_cashmovement_dedup_key).
    clientMessageId?: string | null;
  }
) {
  if (!Number.isFinite(options.amount) || options.amount === 0) {
    throw new Error("CASH_MOVEMENT_AMOUNT_INVALID");
  }

  const description = normalizeCashMovementDescription(options.description);
  if (!description) {
    throw new Error("CASH_MOVEMENT_DESCRIPTION_REQUIRED");
  }

  const signedAmount = signCashMovementAmount(options.type, options.amount);

  return client.cashMovement.create({
    data: {
      businessId: options.businessId,
      saleId: options.saleId ?? null,
      type: options.type,
      description,
      amount: signedAmount,
      date: options.date ?? new Date(),
      paymentMethod: options.paymentMethod ?? null,
      clientMessageId: options.clientMessageId ?? null,
    },
    select: {
      id: true,
      saleId: true,
      type: true,
      description: true,
      amount: true,
      date: true,
      paymentMethod: true,
      clientMessageId: true,
    },
  });
}
