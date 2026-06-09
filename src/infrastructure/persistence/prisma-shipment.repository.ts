import type { PrismaClient } from "@prisma/client";
import { prisma as globalPrisma } from "@/lib/prisma";
import type {
  ShipmentRepositoryPort,
  AndreaniShipmentUpsertArgs,
} from "@/domain/ports/shipment.repository.port";

/**
 * Factory for the Prisma adapter — accepts an injected PrismaClient for
 * testability. Callers that do not need injection can use the singleton
 * export `prismaShipmentRepository` instead.
 */
export function makePrismaShipmentRepository(
  client: PrismaClient,
): ShipmentRepositoryPort {
  return {
    async upsertAndreaniShipment(args: AndreaniShipmentUpsertArgs): Promise<void> {
      // WHERE by saleId — unique constraint ensures idempotence on re-upsert.
      // CREATE includes businessId and initial status="created".
      // UPDATE excludes businessId: tenant ownership must never change on re-upsert.
      // Defense-in-depth: saleId is globally unique per the schema @unique constraint.
      await client.andreaniShipment.upsert({
        where: { saleId: args.saleId },
        create: {
          businessId: args.businessId,
          saleId: args.saleId,
          trackingNumber: args.trackingNumber,
          service: args.service,
          status: "created",
          labelPdfPath: args.labelPdfPath,
          estimatedDelivery: args.estimatedDelivery,
          events: [],
        },
        update: {
          trackingNumber: args.trackingNumber,
          service: args.service,
          status: "created",
          labelPdfPath: args.labelPdfPath,
          estimatedDelivery: args.estimatedDelivery,
        },
      });
    },
  };
}

/** Singleton adapter backed by the global Prisma client. */
// globalPrisma is an $extends()-extended client; the factory only touches model
// delegates, so cast to the base PrismaClient for the singleton wiring.
export const prismaShipmentRepository: ShipmentRepositoryPort =
  makePrismaShipmentRepository(globalPrisma as unknown as PrismaClient);
