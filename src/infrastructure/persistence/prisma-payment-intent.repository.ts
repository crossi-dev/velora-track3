import type { PrismaClient } from "@prisma/client";
import { prisma as globalPrisma } from "@/lib/prisma";
import type {
  PaymentIntentRepositoryPort,
  PaymentIntentPatchCheckoutArgs,
  PaymentIntentPatchCheckoutResult,
} from "@/domain/ports/payment-intent.repository.port";

/**
 * Factory for the Prisma adapter — accepts an injected PrismaClient for
 * testability. Callers that do not need injection can use the singleton
 * export `prismaPaymentIntentRepository` instead.
 */
export function makePrismaPaymentIntentRepository(
  client: PrismaClient,
): PaymentIntentRepositoryPort {
  return {
    async patchCheckout(
      args: PaymentIntentPatchCheckoutArgs,
    ): Promise<PaymentIntentPatchCheckoutResult> {
      // CAS guard: WHERE providerRef: null ensures concurrent callers cannot
      // overwrite each other. Defense-in-depth: id+businessId scope prevents
      // cross-tenant write if paymentIntentId leaked from another tenant.
      // Reference: Brandur "Idempotency Keys", compare-and-swap pattern.
      const { count } = await client.paymentIntent.updateMany({
        where: {
          id: args.paymentIntentId,
          businessId: args.businessId,
          providerRef: null,
        },
        data: {
          providerRef: args.providerRef,
          checkoutUrl: args.checkoutUrl,
        },
      });
      return { count };
    },

    async findByIdAndBusiness(
      paymentIntentId: string,
      businessId: string,
    ): Promise<{ providerRef: string | null } | null> {
      // Scope by businessId — tenant isolation: a missing row could indicate
      // cross-tenant leak; returning null lets the caller handle it.
      return client.paymentIntent.findFirst({
        where: { id: paymentIntentId, businessId },
        select: { providerRef: true },
      });
    },
  };
}

/** Singleton adapter backed by the global Prisma client. */
// globalPrisma is an $extends()-extended client; the factory only touches model
// delegates, so cast to the base PrismaClient for the singleton wiring.
export const prismaPaymentIntentRepository: PaymentIntentRepositoryPort =
  makePrismaPaymentIntentRepository(globalPrisma as unknown as PrismaClient);
