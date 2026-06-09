export interface CriticalWriteArgs {
  businessId: string;
  actorUserId: string;
  actorEmployeeId?: string | null;
  routeScope: string;
  actionType: string;
  resourceType: string;
  resourceId?: string | null;
  summary: string;
  payload: unknown;
  /** Optional diff context — absorbed from the former AuditLog (2026-05-16). */
  input?: unknown;
  before?: unknown;
  after?: unknown;
}

export interface AuditPort {
  recordCriticalWrite(args: CriticalWriteArgs): Promise<boolean>;
}
