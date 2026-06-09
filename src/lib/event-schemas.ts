// Zod runtime schemas for all EmployeeEvent variants.
// Single source of truth for event shapes — domain/events.ts derives its
// TypeScript types from these via ReturnType<typeof schema.parse>.
//
// DoS bounds (.max()) on every string field. Without them, an attacker
// (or buggy client) could submit megabyte-sized eventId / text / fileName
// values, blowing out memory + Cloud Logging + Pub/Sub payload limits.
// Pick conservative ceilings tied to realistic field semantics, not
// arbitrary limits — IDs are cuid-shaped (~25 chars), names fit in 255,
// LLM-style prose tops out around 4 KB.
import { z } from "zod";
import { EMPLOYEE_EVENT_PROTOCOL } from "@/domain/event-protocol";

// String length ceilings — see file-level note for rationale.
const ID_MAX = 64;          // cuid/uuid + room for prefixes
const ISO_MAX = 64;         // ISO-8601 timestamps fit in ~30
const LOCALE_MAX = 32;      // BCP-47 tags
const SHORT_LABEL_MAX = 100;// intent / safeIntent / resource / pattern keys
const NAME_MAX = 255;       // product/supplier/file names
const PROSE_MAX = 4000;     // chat text / supervisor answer / companion answer

export const employeeEventBaseSchema = z.object({
  protocol: z.literal(EMPLOYEE_EVENT_PROTOCOL.name),
  protocolVersion: z.literal(EMPLOYEE_EVENT_PROTOCOL.version),
  eventId: z.string().min(1).max(ID_MAX),
  emittedAt: z.string().min(1).max(ISO_MAX),
  businessId: z.string().min(1).max(ID_MAX),
  actorEmployeeId: z.string().min(1).max(ID_MAX).nullable(),
});

const lowStockItemSchema = z.object({
  productId: z.string().min(1).max(ID_MAX),
  productName: z.string().min(1).max(NAME_MAX),
  remainingUnits: z.number().finite(),
  reorderThreshold: z.number().finite(),
});

const stockIngressItemSchema = z.object({
  productName: z.string().min(1).max(NAME_MAX),
  quantity: z.number().finite().positive(),
  unitCostPrice: z.number().finite().nonnegative(),
});

export const lowStockSchema = employeeEventBaseSchema.extend({
  type: z.literal("LOW_STOCK"),
  saleId: z.string().min(1).max(ID_MAX),
  alerts: z.array(lowStockItemSchema),
});

export const shiftStartSchema = employeeEventBaseSchema.extend({
  type: z.literal("SHIFT_START"),
  actorEmployeeId: z.string().min(1).max(ID_MAX),
  loginAt: z.string().min(1).max(ISO_MAX),
});

export const shiftEndSchema = employeeEventBaseSchema.extend({
  type: z.literal("SHIFT_END"),
  actorEmployeeId: z.string().min(1).max(ID_MAX),
  logoutAt: z.string().min(1).max(ISO_MAX),
  durationMinutes: z.number().finite(),
});

export const cashAtRiskSchema = employeeEventBaseSchema.extend({
  type: z.literal("CASH_AT_RISK"),
  actorEmployeeId: z.string().min(1).max(ID_MAX),
  pattern: z.enum(["pending_sales_spike", "stock_adjustment_spike"]),
  count: z.number().finite(),
  windowMinutes: z.number().finite(),
  totalAmount: z.number().finite(),
});

export const bulkImportCompletedSchema = employeeEventBaseSchema.extend({
  type: z.literal("BULK_IMPORT_COMPLETED"),
  resource: z.string().min(1).max(SHORT_LABEL_MAX),
  inserted: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  fileName: z.string().min(1).max(NAME_MAX),
});

export const chatMessageSchema = employeeEventBaseSchema.extend({
  type: z.literal("CHAT_MESSAGE"),
  text: z.string().min(1).max(PROSE_MAX),
  locale: z.string().min(1).max(LOCALE_MAX).nullable(),
  actorRole: z.enum(["owner", "employee"]),
  clientMessageId: z.string().min(1).max(ID_MAX).nullable(),
});

export const companionResponseSchema = employeeEventBaseSchema.extend({
  type: z.literal("COMPANION_RESPONSE"),
  inReplyToEventId: z.string().min(1).max(ID_MAX),
  intent: z.string().min(1).max(SHORT_LABEL_MAX),
  safeIntent: z.string().min(1).max(SHORT_LABEL_MAX),
  answer: z.string().min(1).max(PROSE_MAX),
  confidence: z.number().finite().nullable(),
  requiresClarification: z.boolean(),
  actionsEmitted: z.array(z.string().min(1).max(SHORT_LABEL_MAX)),
});

export const supervisorQuerySchema = employeeEventBaseSchema.extend({
  type: z.literal("SUPERVISOR_QUERY"),
  inReplyToEventId: z.string().min(1).max(ID_MAX),
  escalationKind: z.enum(["B1_clarification_loop", "B2_long_input", "owner_direct", "companion_answer_escalation"]),
  supervisorAnswer: z.string().min(1).max(PROSE_MAX),
});

export const stockIngressRequestSchema = employeeEventBaseSchema.extend({
  type: z.literal("STOCK_INGRESS_REQUEST"),
  items: z.array(stockIngressItemSchema).min(1),
  supplierName: z.string().max(NAME_MAX).nullable(),
  totalEstimatedValue: z.number().finite().nonnegative(),
  maxIngressTicket: z.number().finite().nonnegative(),
});

export const employeeEventSchema = z.discriminatedUnion("type", [
  lowStockSchema,
  shiftStartSchema,
  shiftEndSchema,
  cashAtRiskSchema,
  bulkImportCompletedSchema,
  chatMessageSchema,
  companionResponseSchema,
  supervisorQuerySchema,
  stockIngressRequestSchema,
]);

export const reportEventPayloadSchema = z.object({
  eventType: z.string().max(100).nullable(),
  details: z.string().max(500).nullable(),
  productName: z.string().max(255).nullable(),
}).strict();
