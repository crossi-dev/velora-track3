import type { Prisma } from "@prisma/client";
import type { Tx } from "@/domain/ports/tx";

/**
 * Boundary cast: the domain passes an opaque `Tx` token to keep Prisma out of
 * the domain/application layer. Adapters convert it back to the real Prisma
 * transaction client at the single point of use. Centralizes the previously
 * scattered `as unknown as Prisma.TransactionClient` double-casts (INV: domain
 * stays Prisma-free; the unsafe cast lives only here).
 */
export function toPrismaTx(tx: Tx): Prisma.TransactionClient {
  return tx as unknown as Prisma.TransactionClient;
}
