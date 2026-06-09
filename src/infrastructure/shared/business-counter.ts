// Shared helper for the BusinessCounter upsert pattern.
//
// Every sequence counter in Velora (invoices, budgets, purchase requests, …)
// uses the same three-field upsert to atomically increment a named counter
// inside a transaction. This module eliminates the four independent copies.
//
// Usage:
//   const raw = await nextBusinessCounter(tx, businessId, "budget");
//   const value = Number.isFinite(raw) && raw > 0 ? raw : <site-specific fallback>;
//
// The helper returns the raw numeric value from the upsert so each call site
// can apply its own ≤0 guard or fallback strategy (they differ across sites).

// We use `any` for the upsert method type to be compatible with both
// Prisma.TransactionClient and the extended prisma singleton (which differs
// in generic parameters after $extends). Same pattern as product-sku.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type BusinessCounterClient = {
  businessCounter: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    upsert: (args: any) => any;
  };
};

/**
 * Atomically increment (or create) the named BusinessCounter row and return
 * the new numeric value. Returns the raw value — callers must validate > 0.
 *
 * @param client  Any Prisma transaction client or structural equivalent.
 * @param businessId  The tenant's businessId (scopes the counter).
 * @param counterType  The counter key, e.g. "budget", "purchase-request",
 *                     "invoice:invoice", "invoice:receipt".
 */
export async function nextBusinessCounter(
  client: BusinessCounterClient,
  businessId: string,
  counterType: string,
): Promise<number> {
  const counter = await client.businessCounter.upsert({
    where: {
      businessId_counterType: { businessId, counterType },
    },
    update: { value: { increment: 1 } },
    create: {
      id: crypto.randomUUID().replace(/-/g, ""),
      businessId,
      counterType,
      value: 1,
    },
    select: { value: true },
  });
  return Number(counter.value);
}
