import { prisma } from "@/lib/prisma";
import type { TransactionPort } from "@/domain/ports/transaction.port";
import type { Tx } from "@/domain/ports/tx";

// Supabase pgbouncer transaction mode has a tight default. Prisma's default
// transaction timeout is 5s, which fails for bulk operations (500-row imports,
// cascade deletes, etc.) with "Transaction not found / refers to an old closed
// transaction" errors. Bump both maxWait (queue) and timeout (execution) to
// generous values that match the bulk-op needs and stay well under Cloud Run's
// per-request budget. Same constant shape used in scripts/db-reset.mjs.
const TRANSACTION_OPTIONS = {
  maxWait: 30_000,
  timeout: 60_000,
};

export const prismaTransactionAdapter: TransactionPort = {
  run<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    // The extended prisma client's $transaction callback provides a tx with InternalArgs,
    // which is structurally compatible at runtime — the cast bridges the type-level mismatch.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (prisma as any).$transaction(
      (prismaTx: unknown) => work(prismaTx as unknown as Tx),
      TRANSACTION_OPTIONS,
    ) as Promise<T>;
  },
};
