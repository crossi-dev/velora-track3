// Zod schema for supervisor LLM output validation.
// Validates `actions[].intent` against the canonical AssistantIntent list
// so a hallucinated or injection-crafted intent string is rejected before
// reaching the client-side command router.

import { z } from "zod";

// Mirror of AssistantIntent — kept in sync with business-assistant/_lib/types.ts.
// Using a local enum here avoids a cross-domain import from _lib into the
// supervisor route.
const CANONICAL_INTENTS = [
  "answer",
  "register_sale",
  "register_movement",
  "adjust_stock",
  "edit_product",
  "delete_product",
  "create_supplier",
  "edit_supplier",
  "delete_supplier",
  "create_customer",
  "edit_customer",
  "stock_load",
  "business_query",
  "bulk_price_update",
  "report_event",
  "create_purchase_request",
  "create_product",
  "return_sale",
  "create_employee",
  "reset_employee_pin",
  "get_employee_credentials",
  "create_business_rule",
  "update_business_rule",
  "delete_business_rule",
  "create_delegation_policy",
  "update_delegation_policy",
  "delete_delegation_policy",
  "broadcast_employees",
  "call_contador_agent",
  "call_ventas_agent",
  "call_payments_agent",
  // call_equipo_agent + call_marketplace_agent ENCAJONADOS 2026-05-25 — supervisor no los emite.
  // Restore por re-listing ambos + el zod variant abajo + re-wire toolContext.
  "call_logistica_agent",
  "update_business_setup",
] as const;

// ─── Strict payload schemas for the top mutation intents ─────────────────────
// Priority order: money-path first, then inventory, then identity/config.
// Intents not listed below fall back to z.record(z.unknown()) — still opaque
// to callers but forces the LLM to emit an object, not a primitive or array.

// register_sale shape consumed by supervisor-action-mapper.ts (productName/customerName/autoSend).
// Items-based shape was introduced in commit a5ffebce but the downstream mapper
// still expects the flat shape — keeping flat here for schema/mapper alignment.
// data is .optional() in the discriminated union as a safety net for model drift.
const registerSaleDataSchema = z.object({
  productName: z.string().max(200).optional(),
  customerName: z.string().max(200).optional(),
  autoSend: z.boolean().optional(),
  // Permissive passthrough for any extra fields the model may emit
}).catchall(z.unknown());

const registerMovementDataSchema = z.object({
  type: z.enum(["income", "expense"]),
  amount: z.number().positive(),
  description: z.string().max(500).optional(),
});

const adjustStockDataSchema = z.object({
  name: z.string().max(200),
  quantity: z.number().int(),
  reason: z.string().max(500).optional(),
});

const editProductDataSchema = z.object({
  name: z.string().max(200),
  newName: z.string().max(200).optional(),
  price: z.number().nonnegative().optional(),
  stock: z.number().int().optional(),
});

const createProductDataSchema = z.object({
  name: z.string().max(200),
  price: z.number().nonnegative(),
  stock: z.number().int().nonnegative().optional(),
});

const deleteProductDataSchema = z.object({
  name: z.string().max(200),
});

const stockLoadDataSchema = z.object({
  name: z.string().max(200),
  quantity: z.number().int().positive(),
  supplierName: z.string().max(200).optional(),
  unitCost: z.number().nonnegative().optional(),
});

const updateBusinessSetupDataSchema = z.object({
  field: z.string().max(100),
  value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]),
});

const createEmployeeDataSchema = z.object({
  name: z.string().max(200),
  role: z.string().max(100).optional(),
});

const resetEmployeePinDataSchema = z.object({
  name: z.string().max(200),
});

// ─── Intent-discriminated action payload ─────────────────────────────────────
// Strict schemas for the 10 highest-risk intents; z.record(z.unknown()) for
// the remaining 23 — still requires an object, rejects primitives/arrays.
const genericData = z.record(z.unknown());

const supervisorActionSchema = z.discriminatedUnion("intent", [
  z.object({ intent: z.literal("register_sale"),        data: registerSaleDataSchema.optional(),       summary: z.string().max(500).optional() }),
  z.object({ intent: z.literal("register_movement"),    data: registerMovementDataSchema,   summary: z.string().max(500).optional() }),
  z.object({ intent: z.literal("adjust_stock"),         data: adjustStockDataSchema,        summary: z.string().max(500).optional() }),
  z.object({ intent: z.literal("edit_product"),         data: editProductDataSchema,        summary: z.string().max(500).optional() }),
  z.object({ intent: z.literal("create_product"),       data: createProductDataSchema,      summary: z.string().max(500).optional() }),
  z.object({ intent: z.literal("delete_product"),       data: deleteProductDataSchema,      summary: z.string().max(500).optional() }),
  z.object({ intent: z.literal("stock_load"),           data: stockLoadDataSchema,          summary: z.string().max(500).optional() }),
  z.object({ intent: z.literal("update_business_setup"),data: updateBusinessSetupDataSchema,summary: z.string().max(500).optional() }),
  z.object({ intent: z.literal("create_employee"),      data: createEmployeeDataSchema,     summary: z.string().max(500).optional() }),
  z.object({ intent: z.literal("reset_employee_pin"),   data: resetEmployeePinDataSchema,   summary: z.string().max(500).optional() }),
  // Remaining intents — object required, fields unconstrained.
  z.object({ intent: z.literal("answer"),                      data: genericData, summary: z.string().max(500).optional() }),
  z.object({ intent: z.literal("create_supplier"),             data: genericData, summary: z.string().max(500).optional() }),
  z.object({ intent: z.literal("edit_supplier"),               data: genericData, summary: z.string().max(500).optional() }),
  z.object({ intent: z.literal("delete_supplier"),             data: genericData, summary: z.string().max(500).optional() }),
  z.object({ intent: z.literal("create_customer"),             data: genericData, summary: z.string().max(500).optional() }),
  z.object({ intent: z.literal("edit_customer"),               data: genericData, summary: z.string().max(500).optional() }),
  z.object({ intent: z.literal("business_query"),              data: genericData, summary: z.string().max(500).optional() }),
  z.object({ intent: z.literal("bulk_price_update"),           data: genericData, summary: z.string().max(500).optional() }),
  z.object({ intent: z.literal("report_event"),                data: genericData, summary: z.string().max(500).optional() }),
  z.object({ intent: z.literal("create_purchase_request"),     data: genericData, summary: z.string().max(500).optional() }),
  z.object({ intent: z.literal("return_sale"),                 data: genericData, summary: z.string().max(500).optional() }),
  z.object({ intent: z.literal("get_employee_credentials"),    data: genericData, summary: z.string().max(500).optional() }),
  z.object({ intent: z.literal("create_business_rule"),        data: genericData, summary: z.string().max(500).optional() }),
  z.object({ intent: z.literal("update_business_rule"),        data: genericData, summary: z.string().max(500).optional() }),
  z.object({ intent: z.literal("delete_business_rule"),        data: genericData, summary: z.string().max(500).optional() }),
  z.object({ intent: z.literal("create_delegation_policy"),    data: genericData, summary: z.string().max(500).optional() }),
  z.object({ intent: z.literal("update_delegation_policy"),    data: genericData, summary: z.string().max(500).optional() }),
  z.object({ intent: z.literal("delete_delegation_policy"),    data: genericData, summary: z.string().max(500).optional() }),
  z.object({ intent: z.literal("broadcast_employees"),         data: genericData, summary: z.string().max(500).optional() }),
  z.object({ intent: z.literal("call_contador_agent"),         data: genericData, summary: z.string().max(500).optional() }),
  z.object({ intent: z.literal("call_ventas_agent"),           data: genericData, summary: z.string().max(500).optional() }),
  z.object({ intent: z.literal("call_payments_agent"),         data: genericData, summary: z.string().max(500).optional() }),
  z.object({ intent: z.literal("call_logistica_agent"),        data: genericData, summary: z.string().max(500).optional() }),
  z.object({ intent: z.literal("call_communications_agent"),  data: genericData, summary: z.string().max(500).optional() }),
  // call_equipo_agent + call_marketplace_agent ENCAJONADOS 2026-05-25.
]);

export const supervisorResponseSchema = z.object({
  kind: z.enum(["actions", "clarification", "answer", "notification"]),
  answer: z.string().max(2000).nullish(),
  actions: z.array(supervisorActionSchema).nullable().optional(),
  clarification: z
    .object({
      question: z.string().max(500),
      // context is optional — the LLM sometimes omits it. Default to empty string
      // so downstream code (supervisor-parser.ts line 181) always reads safely.
      // Fix: BUG #42 — SUPERVISOR_SCHEMA_INVALID / SUPERVISOR_PARSE_FAILED retry loop.
      context: z.string().max(500).optional().default(""),
    })
    .nullable()
    .optional(),
  notification: z
    .object({
      level: z.enum(["now", "daily", "drop"]),
      title: z.string().max(200).optional(),
      body: z.string().max(1000).optional(),
      reason: z.string().max(500).optional(),
    })
    .nullable()
    .optional(),
  chips: z
    .object({
      kind: z.enum(["single", "multi", "action"]),
      options: z
        .array(
          z.object({
            label: z.string().max(40),
            // Value capped at 512 here so the supervisorResponseSchema does
            // not reject turns where the model emits a long chip value (e.g.
            // full MP checkout URLs). parseChipsBundle enforces the stricter
            // 80-char cap before chips reach the client.
            value: z.string().max(512),
            // .catch(undefined) coerces unknown action strings (e.g. "mp_link")
            // to undefined instead of failing the whole schema and discarding
            // the Supervisor turn. parseChipsBundle re-validates against
            // VALID_ACTIONS before any chip reaches the client. Bug #47.
            action: z.enum(["subscribe_push"]).optional().catch(undefined),
          })
        )
        .min(1)
        .max(8),
    })
    .nullable()
    .optional(),
});

export type SupervisorSchemaInput = z.input<typeof supervisorResponseSchema>;
