import { prisma } from "@/lib/prisma";
import type { EmployeeRepositoryPort, EmployeeCreateArgs, EmployeeRecord, EmployeeListRecord } from "@/domain/ports/employee.repository.port";

export const prismaEmployeeRepository: EmployeeRepositoryPort = {
  async findByName(businessId: string, name: string) {
    return prisma.employee.findUnique({
      where: { businessId_name: { businessId, name } },
      select: { id: true },
    });
  },

  async create(args: EmployeeCreateArgs): Promise<EmployeeRecord> {
    return prisma.employee.create({
      data: { businessId: args.businessId, name: args.name, pinHash: args.pinHash, role: args.role },
      select: { id: true, name: true, role: true, active: true, createdAt: true },
    });
  },

  async findById(businessId: string, employeeId: string) {
    return prisma.employee.findFirst({
      where: { id: employeeId, businessId },
      select: { id: true, name: true, role: true, active: true },
    });
  },

  async revoke(businessId: string, employeeId: string): Promise<void> {
    // Defense-in-depth tenant guard: updateMany scoped by both id+businessId
    // prevents cross-tenant revocation if a stale employeeId leaks through
    // upstream validation. Returns count, not row — we treat count==0 as
    // already-revoked / not-found (caller verified existence already).
    await prisma.employee.updateMany({
      where: { id: employeeId, businessId },
      data: { active: false },
    });
  },

  async list(businessId: string): Promise<EmployeeListRecord[]> {
    return prisma.employee.findMany({
      where: { businessId },
      select: { id: true, name: true, role: true, active: true, lastLoginAt: true, createdAt: true, lockedUntil: true, failedPinAttempts: true },
      orderBy: { createdAt: "asc" },
      take: 200,
    });
  },
};
