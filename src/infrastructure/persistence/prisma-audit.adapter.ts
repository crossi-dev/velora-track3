import { prisma } from "@/lib/prisma";
import { recordCriticalWriteEvent } from "@/infrastructure/shared/critical-write-audit";
import type { AuditPort, CriticalWriteArgs } from "@/domain/ports/audit.port";

export const prismaAuditAdapter: AuditPort = {
  recordCriticalWrite(args: CriticalWriteArgs): Promise<boolean> {
    return recordCriticalWriteEvent({ client: prisma, ...args });
  },
};
