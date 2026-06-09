// Velora domain events — TypeScript types derived from Zod schemas in
// lib/event-schemas.ts. Zod schemas are the single source of truth;
// adding or changing a field here requires updating the schema first.
export { EMPLOYEE_EVENT_PROTOCOL } from "./event-protocol";

import type {
  employeeEventBaseSchema,
  employeeEventSchema,
  lowStockSchema,
  shiftStartSchema,
  shiftEndSchema,
  cashAtRiskSchema,
  bulkImportCompletedSchema,
  chatMessageSchema,
  companionResponseSchema,
  supervisorQuerySchema,
  stockIngressRequestSchema,
} from "@/lib/event-schemas";

export type EmployeeEventBase   = ReturnType<typeof employeeEventBaseSchema.parse>;
export type EmployeeEvent       = ReturnType<typeof employeeEventSchema.parse>;
export type EmployeeEventType   = EmployeeEvent["type"];
export type LowStockEvent              = ReturnType<typeof lowStockSchema.parse>;
export type ShiftStartEvent            = ReturnType<typeof shiftStartSchema.parse>;
export type ShiftEndEvent              = ReturnType<typeof shiftEndSchema.parse>;
export type CashAtRiskEvent            = ReturnType<typeof cashAtRiskSchema.parse>;
export type BulkImportCompletedEvent   = ReturnType<typeof bulkImportCompletedSchema.parse>;
export type ChatMessageEvent           = ReturnType<typeof chatMessageSchema.parse>;
export type CompanionResponseEvent     = ReturnType<typeof companionResponseSchema.parse>;
export type SupervisorQueryEvent       = ReturnType<typeof supervisorQuerySchema.parse>;
export type StockIngressRequestEvent   = ReturnType<typeof stockIngressRequestSchema.parse>;
