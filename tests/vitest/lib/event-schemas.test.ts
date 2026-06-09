import { describe, it, expect } from "vitest";
import {
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
  reportEventPayloadSchema,
} from "@/lib/event-schemas";

const BASE = {
  protocol: "velora.employee.event" as const,
  protocolVersion: "1.0.0" as const,
  eventId: "evt-001",
  emittedAt: "2024-01-01T00:00:00.000Z",
  businessId: "biz-001",
  actorEmployeeId: "emp-001",
};

// ── employeeEventBaseSchema ───────────────────────────────────────────────────

describe("employeeEventBaseSchema", () => {
  it("base válido → parsea", () => expect(employeeEventBaseSchema.safeParse(BASE).success).toBe(true));
  it("protocol incorrecto → falla", () => {
    expect(employeeEventBaseSchema.safeParse({ ...BASE, protocol: "other.protocol" }).success).toBe(false);
  });
  it("protocolVersion incorrecto → falla", () => {
    expect(employeeEventBaseSchema.safeParse({ ...BASE, protocolVersion: "2.0.0" }).success).toBe(false);
  });
  it("actorEmployeeId null → válido (nullable)", () => {
    expect(employeeEventBaseSchema.safeParse({ ...BASE, actorEmployeeId: null }).success).toBe(true);
  });
  it("eventId vacío → falla", () => {
    expect(employeeEventBaseSchema.safeParse({ ...BASE, eventId: "" }).success).toBe(false);
  });
  it("eventId supera 64 chars → falla (DoS bound)", () => {
    expect(employeeEventBaseSchema.safeParse({ ...BASE, eventId: "x".repeat(65) }).success).toBe(false);
  });
  it("businessId supera 64 chars → falla (DoS bound)", () => {
    expect(employeeEventBaseSchema.safeParse({ ...BASE, businessId: "x".repeat(65) }).success).toBe(false);
  });
});

// ── LOW_STOCK ─────────────────────────────────────────────────────────────────

const LOW_STOCK_VALID = {
  ...BASE,
  type: "LOW_STOCK" as const,
  saleId: "sale-001",
  alerts: [{ productId: "prod-001", productName: "Yerba", remainingUnits: 2, reorderThreshold: 5 }],
};

describe("lowStockSchema", () => {
  it("evento válido → parsea", () => expect(lowStockSchema.safeParse(LOW_STOCK_VALID).success).toBe(true));
  it("sin saleId → falla", () => {
    const { saleId: _, ...rest } = LOW_STOCK_VALID;
    expect(lowStockSchema.safeParse(rest).success).toBe(false);
  });
  it("alerts vacío → válido (el schema no exige min 1 en alerts)", () => {
    expect(lowStockSchema.safeParse({ ...LOW_STOCK_VALID, alerts: [] }).success).toBe(true);
  });
  it("alert con remainingUnits=Infinity → falla (no finito)", () => {
    const bad = { ...LOW_STOCK_VALID, alerts: [{ productId: "p", productName: "n", remainingUnits: Infinity, reorderThreshold: 5 }] };
    expect(lowStockSchema.safeParse(bad).success).toBe(false);
  });
});

// ── SHIFT_START ───────────────────────────────────────────────────────────────

const SHIFT_START_VALID = {
  ...BASE,
  type: "SHIFT_START" as const,
  actorEmployeeId: "emp-001",
  loginAt: "2024-01-01T08:00:00.000Z",
};

describe("shiftStartSchema", () => {
  it("evento válido → parsea", () => expect(shiftStartSchema.safeParse(SHIFT_START_VALID).success).toBe(true));
  it("actorEmployeeId null → falla (no nullable en SHIFT_START)", () => {
    expect(shiftStartSchema.safeParse({ ...SHIFT_START_VALID, actorEmployeeId: null }).success).toBe(false);
  });
  it("sin loginAt → falla", () => {
    const { loginAt: _, ...rest } = SHIFT_START_VALID;
    expect(shiftStartSchema.safeParse(rest).success).toBe(false);
  });
});

// ── SHIFT_END ─────────────────────────────────────────────────────────────────

const SHIFT_END_VALID = {
  ...BASE,
  type: "SHIFT_END" as const,
  actorEmployeeId: "emp-001",
  logoutAt: "2024-01-01T17:00:00.000Z",
  durationMinutes: 480,
};

describe("shiftEndSchema", () => {
  it("evento válido → parsea", () => expect(shiftEndSchema.safeParse(SHIFT_END_VALID).success).toBe(true));
  it("durationMinutes no-finito → falla", () => {
    expect(shiftEndSchema.safeParse({ ...SHIFT_END_VALID, durationMinutes: NaN }).success).toBe(false);
  });
});

// ── CASH_AT_RISK ──────────────────────────────────────────────────────────────

const CASH_AT_RISK_VALID = {
  ...BASE,
  type: "CASH_AT_RISK" as const,
  actorEmployeeId: "emp-001",
  pattern: "pending_sales_spike" as const,
  count: 5,
  windowMinutes: 60,
  totalAmount: 500,
};

describe("cashAtRiskSchema", () => {
  it("evento válido → parsea", () => expect(cashAtRiskSchema.safeParse(CASH_AT_RISK_VALID).success).toBe(true));
  it("pattern inválido → falla", () => {
    expect(cashAtRiskSchema.safeParse({ ...CASH_AT_RISK_VALID, pattern: "unknown_pattern" }).success).toBe(false);
  });
  it("patterns válidos aceptados", () => {
    for (const p of ["pending_sales_spike", "stock_adjustment_spike"] as const) {
      expect(cashAtRiskSchema.safeParse({ ...CASH_AT_RISK_VALID, pattern: p }).success).toBe(true);
    }
  });
});

// ── BULK_IMPORT_COMPLETED ─────────────────────────────────────────────────────

const BULK_IMPORT_VALID = {
  ...BASE,
  type: "BULK_IMPORT_COMPLETED" as const,
  resource: "products",
  inserted: 10,
  updated: 2,
  skipped: 1,
  fileName: "products.xlsx",
};

describe("bulkImportCompletedSchema", () => {
  it("evento válido → parsea", () => expect(bulkImportCompletedSchema.safeParse(BULK_IMPORT_VALID).success).toBe(true));
  it("inserted negativo → falla (nonnegative)", () => {
    expect(bulkImportCompletedSchema.safeParse({ ...BULK_IMPORT_VALID, inserted: -1 }).success).toBe(false);
  });
  it("inserted decimal → falla (int)", () => {
    expect(bulkImportCompletedSchema.safeParse({ ...BULK_IMPORT_VALID, inserted: 1.5 }).success).toBe(false);
  });
});

// ── CHAT_MESSAGE ──────────────────────────────────────────────────────────────

const CHAT_MSG_VALID = {
  ...BASE,
  type: "CHAT_MESSAGE" as const,
  text: "Hola",
  locale: "es-AR",
  actorRole: "employee" as const,
  clientMessageId: "msg-001",
};

describe("chatMessageSchema", () => {
  it("evento válido → parsea", () => expect(chatMessageSchema.safeParse(CHAT_MSG_VALID).success).toBe(true));
  it("actorRole inválido → falla", () => {
    expect(chatMessageSchema.safeParse({ ...CHAT_MSG_VALID, actorRole: "manager" }).success).toBe(false);
  });
  it("locale null → válido (nullable)", () => {
    expect(chatMessageSchema.safeParse({ ...CHAT_MSG_VALID, locale: null }).success).toBe(true);
  });
  it("clientMessageId null → válido (nullable)", () => {
    expect(chatMessageSchema.safeParse({ ...CHAT_MSG_VALID, clientMessageId: null }).success).toBe(true);
  });
  it("actorRole 'owner' → válido", () => {
    expect(chatMessageSchema.safeParse({ ...CHAT_MSG_VALID, actorRole: "owner" }).success).toBe(true);
  });
  it("text supera 4000 chars → falla (DoS bound)", () => {
    expect(chatMessageSchema.safeParse({ ...CHAT_MSG_VALID, text: "x".repeat(4001) }).success).toBe(false);
  });
  it("text 4000 chars exactos → válido", () => {
    expect(chatMessageSchema.safeParse({ ...CHAT_MSG_VALID, text: "x".repeat(4000) }).success).toBe(true);
  });
});

// ── COMPANION_RESPONSE ────────────────────────────────────────────────────────

const COMPANION_RESP_VALID = {
  ...BASE,
  type: "COMPANION_RESPONSE" as const,
  inReplyToEventId: "evt-000",
  intent: "answer",
  safeIntent: "answer",
  answer: "Sí, entendido.",
  confidence: 0.9,
  requiresClarification: false,
  actionsEmitted: ["register_sale"],
};

describe("companionResponseSchema", () => {
  it("evento válido → parsea", () => expect(companionResponseSchema.safeParse(COMPANION_RESP_VALID).success).toBe(true));
  it("confidence null → válido (nullable)", () => {
    expect(companionResponseSchema.safeParse({ ...COMPANION_RESP_VALID, confidence: null }).success).toBe(true);
  });
  it("sin inReplyToEventId → falla", () => {
    const { inReplyToEventId: _, ...rest } = COMPANION_RESP_VALID;
    expect(companionResponseSchema.safeParse(rest).success).toBe(false);
  });
});

// ── SUPERVISOR_QUERY ──────────────────────────────────────────────────────────

const SUPERVISOR_QUERY_VALID = {
  ...BASE,
  type: "SUPERVISOR_QUERY" as const,
  inReplyToEventId: "evt-000",
  escalationKind: "B1_clarification_loop" as const,
  supervisorAnswer: "Entiendo la consulta.",
};

describe("supervisorQuerySchema", () => {
  it("evento válido → parsea", () => expect(supervisorQuerySchema.safeParse(SUPERVISOR_QUERY_VALID).success).toBe(true));
  it("escalationKind inválido → falla", () => {
    expect(supervisorQuerySchema.safeParse({ ...SUPERVISOR_QUERY_VALID, escalationKind: "unknown" }).success).toBe(false);
  });
  it("todos los escalationKinds válidos aceptados", () => {
    for (const kind of ["B1_clarification_loop", "B2_long_input", "owner_direct", "companion_answer_escalation"] as const) {
      expect(supervisorQuerySchema.safeParse({ ...SUPERVISOR_QUERY_VALID, escalationKind: kind }).success).toBe(true);
    }
  });
  it("supervisorAnswer supera 4000 chars → falla (DoS bound)", () => {
    expect(supervisorQuerySchema.safeParse({ ...SUPERVISOR_QUERY_VALID, supervisorAnswer: "x".repeat(4001) }).success).toBe(false);
  });
});

// ── STOCK_INGRESS_REQUEST ─────────────────────────────────────────────────────

const STOCK_INGRESS_VALID = {
  ...BASE,
  type: "STOCK_INGRESS_REQUEST" as const,
  items: [{ productName: "Yerba", quantity: 10, unitCostPrice: 100 }],
  supplierName: "Proveedor SA",
  totalEstimatedValue: 1000,
  maxIngressTicket: 500,
};

describe("stockIngressRequestSchema", () => {
  it("evento válido → parsea", () => expect(stockIngressRequestSchema.safeParse(STOCK_INGRESS_VALID).success).toBe(true));
  it("items vacío → falla (min 1)", () => {
    expect(stockIngressRequestSchema.safeParse({ ...STOCK_INGRESS_VALID, items: [] }).success).toBe(false);
  });
  it("supplierName null → válido (nullable)", () => {
    expect(stockIngressRequestSchema.safeParse({ ...STOCK_INGRESS_VALID, supplierName: null }).success).toBe(true);
  });
  it("item quantity negativa → falla (positive)", () => {
    const bad = { ...STOCK_INGRESS_VALID, items: [{ productName: "x", quantity: -1, unitCostPrice: 0 }] };
    expect(stockIngressRequestSchema.safeParse(bad).success).toBe(false);
  });
  it("item unitCostPrice negativa → falla (nonnegative)", () => {
    const bad = { ...STOCK_INGRESS_VALID, items: [{ productName: "x", quantity: 1, unitCostPrice: -5 }] };
    expect(stockIngressRequestSchema.safeParse(bad).success).toBe(false);
  });
});

// ── employeeEventSchema (discriminated union) ─────────────────────────────────

describe("employeeEventSchema — discriminated union", () => {
  it("tipo desconocido → falla", () => {
    expect(employeeEventSchema.safeParse({ ...BASE, type: "UNKNOWN_TYPE" }).success).toBe(false);
  });
  it("sin campo 'type' → falla", () => {
    expect(employeeEventSchema.safeParse(BASE).success).toBe(false);
  });
  it("LOW_STOCK válido → parsea", () => expect(employeeEventSchema.safeParse(LOW_STOCK_VALID).success).toBe(true));
  it("SHIFT_START válido → parsea", () => expect(employeeEventSchema.safeParse(SHIFT_START_VALID).success).toBe(true));
  it("STOCK_INGRESS_REQUEST válido → parsea", () => expect(employeeEventSchema.safeParse(STOCK_INGRESS_VALID).success).toBe(true));
});

// ── reportEventPayloadSchema ──────────────────────────────────────────────────

describe("reportEventPayloadSchema", () => {
  it("todos null → válido", () => {
    expect(reportEventPayloadSchema.safeParse({ eventType: null, details: null, productName: null }).success).toBe(true);
  });
  it("todos strings → válido", () => {
    expect(reportEventPayloadSchema.safeParse({ eventType: "LOW_STOCK", details: "Stock bajo", productName: "Yerba" }).success).toBe(true);
  });
  it("campo extra → falla (strict)", () => {
    expect(reportEventPayloadSchema.safeParse({ eventType: null, details: null, productName: null, extra: "x" }).success).toBe(false);
  });
  it("eventType supera 100 chars → falla", () => {
    expect(reportEventPayloadSchema.safeParse({ eventType: "x".repeat(101), details: null, productName: null }).success).toBe(false);
  });
  it("details supera 500 chars → falla", () => {
    expect(reportEventPayloadSchema.safeParse({ eventType: null, details: "x".repeat(501), productName: null }).success).toBe(false);
  });
  it("productName supera 255 chars → falla", () => {
    expect(reportEventPayloadSchema.safeParse({ eventType: null, details: null, productName: "x".repeat(256) }).success).toBe(false);
  });
});
