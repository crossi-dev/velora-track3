import { prisma } from "@/lib/prisma";
import type { BusinessRuleRepositoryPort, BusinessRuleCreateArgs, BusinessRuleRecord } from "@/domain/ports/business-rule.repository.port";


export const prismaBusinessRuleRepository: BusinessRuleRepositoryPort = {
  async findByTrigger(businessId: string, trigger: string) {
    return prisma.businessRule.findFirst({
      where: { businessId, trigger },
      select: { id: true, kind: true },
    });
  },

  async create(args: BusinessRuleCreateArgs): Promise<BusinessRuleRecord> {
    return prisma.businessRule.create({
      data: { businessId: args.businessId, kind: args.kind, trigger: args.trigger, message: args.message, active: true },
      select: { id: true, kind: true, trigger: true, message: true, active: true, createdAt: true, updatedAt: true },
    });
  },

  async list(businessId: string): Promise<BusinessRuleRecord[]> {
    return prisma.businessRule.findMany({
      where: { businessId },
      orderBy: { createdAt: "desc" },
      take: 200,
      select: { id: true, kind: true, trigger: true, message: true, active: true, createdAt: true, updatedAt: true },
    });
  },

  async update(businessId: string, ruleId: string, updates: { kind?: string; trigger?: string; message?: string; active?: boolean }): Promise<BusinessRuleRecord | null> {
    const existing = await prisma.businessRule.findFirst({ where: { id: ruleId, businessId }, select: { id: true } });
    if (!existing) return null;
    // Defense-in-depth tenant guard: scope write by both id+businessId to prevent
    // cross-tenant mutation if ruleId leaked through the prior findFirst check.
    return prisma.businessRule.update({
      where: { id: ruleId, businessId },
      data: updates,
      select: { id: true, kind: true, trigger: true, message: true, active: true, createdAt: true, updatedAt: true },
    });
  },

  async delete(businessId: string, ruleId: string): Promise<{ deleted: boolean }> {
    const existing = await prisma.businessRule.findFirst({ where: { id: ruleId, businessId }, select: { id: true } });
    if (!existing) return { deleted: false };
    // Defense-in-depth tenant guard: scope delete by both id+businessId to prevent
    // cross-tenant deletion if ruleId leaked through the prior findFirst check.
    await prisma.businessRule.deleteMany({ where: { id: ruleId, businessId } });
    return { deleted: true };
  },

  async deactivateAllActiveByTrigger(businessId: string, trigger: string): Promise<{ count: number }> {
    // Restores old updateMany({active:true}) → {active:false} semantics.
    // Deactivates ALL active rows matching the trigger (no unique constraint on trigger).
    const result = await prisma.businessRule.updateMany({
      where: { businessId, trigger, active: true },
      data: { active: false },
    });
    return { count: result.count };
  },
};
