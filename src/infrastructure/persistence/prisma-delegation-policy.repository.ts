import type { PrismaClient, DelegationPolicy } from "@prisma/client";
import { prisma as globalPrisma } from "@/lib/prisma";
import type {
  DelegationPolicyRepositoryPort,
  DelegationPolicyCreateArgs,
  DelegationPolicyRecord,
} from "@/domain/ports/delegation-policy.repository.port";

/** Map a Prisma row to the domain record (Decimal maxValue → number | null). */
function toRecord(row: DelegationPolicy): DelegationPolicyRecord {
  return {
    id: row.id,
    scope: row.scope,
    maxValue: row.maxValue === null ? null : row.maxValue.toNumber(),
    requiresOwner: row.requiresOwner,
    conditions: row.conditions,
    active: row.active,
  };
}

/**
 * Factory for the Prisma adapter — accepts an injected PrismaClient for
 * testability. Callers that do not need injection can use the singleton
 * export `prismaDelegationPolicyRepository` instead.
 */
export function makePrismaDelegationPolicyRepository(
  client: PrismaClient,
): DelegationPolicyRepositoryPort {
  return {
    async findActiveByScope(
      businessId: string,
      scope: string,
    ): Promise<{ id: string } | null> {
      // Scope by businessId — tenant isolation.
      return client.delegationPolicy.findFirst({
        where: { businessId, scope, active: true },
        select: { id: true },
      });
    },

    async create(
      args: DelegationPolicyCreateArgs,
    ): Promise<DelegationPolicyRecord> {
      const row = await client.delegationPolicy.create({
        data: {
          businessId: args.businessId,
          scope: args.scope,
          maxValue: args.maxValue,
          requiresOwner: args.requiresOwner,
          conditions: args.conditions,
          active: true,
        },
      });
      return toRecord(row);
    },

    async update(
      businessId: string,
      policyId: string,
      updates: {
        maxValue?: number | null;
        requiresOwner?: boolean;
        conditions?: string;
        active?: boolean;
      },
    ): Promise<DelegationPolicyRecord | null> {
      // Tenant isolation: confirm the row belongs to this business before
      // updating. Returns null when not found (or owned by another tenant).
      const existing = await client.delegationPolicy.findFirst({
        where: { id: policyId, businessId },
        select: { id: true },
      });
      if (!existing) return null;
      const row = await client.delegationPolicy.update({
        where: { id: policyId, businessId },
        data: updates,
      });
      return toRecord(row);
    },

    async softDeleteByScope(
      businessId: string,
      scope: string,
    ): Promise<{ count: number }> {
      // Scope by businessId — tenant isolation.
      const { count } = await client.delegationPolicy.updateMany({
        where: { businessId, scope, active: true },
        data: { active: false },
      });
      return { count };
    },
  };
}

/** Singleton adapter backed by the global Prisma client. */
// globalPrisma is an $extends()-extended client; the factory only touches model
// delegates, so cast to the base PrismaClient for the singleton wiring.
export const prismaDelegationPolicyRepository: DelegationPolicyRepositoryPort =
  makePrismaDelegationPolicyRepository(globalPrisma as unknown as PrismaClient);
