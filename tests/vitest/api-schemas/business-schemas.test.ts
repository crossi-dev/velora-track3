import { describe, it, expect } from "vitest";
import { businessUpdateSchema } from "@/app/api/business/business-schema";
import {
  createBusinessRuleBodySchema,
  updateBusinessRuleBodySchema,
} from "@/app/api/business/business-rules/business-rule-schema";
import { createCashMovementBodySchema } from "@/app/api/cash-movements/cash-movement-schema";
import { updateInvoiceStatusBodySchema } from "@/app/api/invoices/invoice-schema";
import { pushSubscribeBodySchema } from "@/app/api/push-notifications/push-schema";
import { supervisorResponseSchema } from "@/app/api/supervisor/_lib/supervisor-schema";

// ── businessUpdateSchema ──────────────────────────────────────────────────────

describe("businessUpdateSchema", () => {
  it("objeto vacío → parsea (todos opcionales)", () => expect(businessUpdateSchema.safeParse({}).success).toBe(true));
  it("solo name → parsea", () => expect(businessUpdateSchema.safeParse({ name: "Mi Tienda" }).success).toBe(true));
  it("email inválido → falla", () => expect(businessUpdateSchema.safeParse({ email: "no-email" }).success).toBe(false));
  it("email null → parsea (nullable)", () => expect(businessUpdateSchema.safeParse({ email: null }).success).toBe(true));
  it("taxRate como string vacío → coerce a undefined", () => expect(businessUpdateSchema.safeParse({ taxRate: "" }).success).toBe(true));
  it("taxRate negativo → falla (nonnegative)", () => expect(businessUpdateSchema.safeParse({ taxRate: -1 }).success).toBe(false));
  it("allowNegativeStock boolean → parsea", () => expect(businessUpdateSchema.safeParse({ allowNegativeStock: true }).success).toBe(true));
  it("lowStockThreshold decimal → falla (int)", () => expect(businessUpdateSchema.safeParse({ lowStockThreshold: 1.5 }).success).toBe(false));
  it("lowStockThreshold negativo → falla (nonnegative)", () => expect(businessUpdateSchema.safeParse({ lowStockThreshold: -1 }).success).toBe(false));
  it("campo extra → falla (strict)", () => expect(businessUpdateSchema.safeParse({ unknownField: "x" }).success).toBe(false));
});

// ── createBusinessRuleBodySchema ──────────────────────────────────────────────

describe("createBusinessRuleBodySchema", () => {
  const valid = { kind: "time-based" as const, trigger: "Lunes a las 9am", message: "Revisá el stock" };
  it("regla válida → parsea", () => expect(createBusinessRuleBodySchema.safeParse(valid).success).toBe(true));
  it("kind 'condition-based' → parsea", () => {
    expect(createBusinessRuleBodySchema.safeParse({ ...valid, kind: "condition-based" }).success).toBe(true);
  });
  it("kind 'behavior-based' → parsea", () => {
    expect(createBusinessRuleBodySchema.safeParse({ ...valid, kind: "behavior-based" }).success).toBe(true);
  });
  it("kind inválido → falla", () => {
    expect(createBusinessRuleBodySchema.safeParse({ ...valid, kind: "scheduled" }).success).toBe(false);
  });
  it("trigger vacío → falla", () => {
    expect(createBusinessRuleBodySchema.safeParse({ ...valid, trigger: "" }).success).toBe(false);
  });
  it("trigger supera 500 chars → falla", () => {
    expect(createBusinessRuleBodySchema.safeParse({ ...valid, trigger: "x".repeat(501) }).success).toBe(false);
  });
  it("message vacío → falla", () => {
    expect(createBusinessRuleBodySchema.safeParse({ ...valid, message: "" }).success).toBe(false);
  });
  it("message supera 1000 chars → falla", () => {
    expect(createBusinessRuleBodySchema.safeParse({ ...valid, message: "x".repeat(1001) }).success).toBe(false);
  });
  it("campo extra → falla (strict)", () => {
    expect(createBusinessRuleBodySchema.safeParse({ ...valid, active: true }).success).toBe(false);
  });
});

// ── updateBusinessRuleBodySchema ──────────────────────────────────────────────

describe("updateBusinessRuleBodySchema", () => {
  it("solo active → parsea", () => expect(updateBusinessRuleBodySchema.safeParse({ active: false }).success).toBe(true));
  it("solo kind → parsea", () => expect(updateBusinessRuleBodySchema.safeParse({ kind: "time-based" }).success).toBe(true));
  it("objeto vacío → falla (refine: al menos un campo)", () => expect(updateBusinessRuleBodySchema.safeParse({}).success).toBe(false));
  it("kind inválido → falla", () => expect(updateBusinessRuleBodySchema.safeParse({ kind: "other" }).success).toBe(false));
  it("trigger supera 500 chars → falla", () => {
    expect(updateBusinessRuleBodySchema.safeParse({ trigger: "x".repeat(501) }).success).toBe(false);
  });
  it("campo extra → falla (strict)", () => {
    expect(updateBusinessRuleBodySchema.safeParse({ active: true, extra: "x" }).success).toBe(false);
  });
});

// ── createCashMovementBodySchema ──────────────────────────────────────────────

describe("createCashMovementBodySchema", () => {
  const valid = { type: "purchase" as const, description: "Compra de mercadería", amount: 5000 };
  it("movimiento válido → parsea", () => expect(createCashMovementBodySchema.safeParse(valid).success).toBe(true));
  it("con fecha → parsea", () => {
    expect(createCashMovementBodySchema.safeParse({ ...valid, date: "2024-01-15" }).success).toBe(true);
  });
  it("tipo inválido → falla", () => {
    expect(createCashMovementBodySchema.safeParse({ ...valid, type: "sale" }).success).toBe(false);
  });
  it("todos los tipos válidos aceptados", () => {
    for (const t of ["purchase", "tax", "salary", "adjustment", "income"] as const) {
      expect(createCashMovementBodySchema.safeParse({ ...valid, type: t }).success).toBe(true);
    }
  });
  it("descripción vacía → falla", () => {
    expect(createCashMovementBodySchema.safeParse({ ...valid, description: "" }).success).toBe(false);
  });
  it("monto = 0 → falla (refine !== 0)", () => {
    expect(createCashMovementBodySchema.safeParse({ ...valid, amount: 0 }).success).toBe(false);
  });
  it("monto negativo → parsea (permite retiros)", () => {
    expect(createCashMovementBodySchema.safeParse({ ...valid, amount: -100 }).success).toBe(true);
  });
  it("monto Infinity → falla (finite)", () => {
    expect(createCashMovementBodySchema.safeParse({ ...valid, amount: Infinity }).success).toBe(false);
  });
  it("fecha formato inválido → falla", () => {
    expect(createCashMovementBodySchema.safeParse({ ...valid, date: "15-01-2024" }).success).toBe(false);
  });
  it("campo extra → falla (strict)", () => {
    expect(createCashMovementBodySchema.safeParse({ ...valid, extra: "x" }).success).toBe(false);
  });
});

// ── updateInvoiceStatusBodySchema ─────────────────────────────────────────────

describe("updateInvoiceStatusBodySchema", () => {
  it("status 'issued' → parsea", () => expect(updateInvoiceStatusBodySchema.safeParse({ status: "issued" }).success).toBe(true));
  it("status 'sent' → parsea", () => expect(updateInvoiceStatusBodySchema.safeParse({ status: "sent" }).success).toBe(true));
  it("status 'paid' → parsea", () => expect(updateInvoiceStatusBodySchema.safeParse({ status: "paid" }).success).toBe(true));
  it("status inválido → falla", () => expect(updateInvoiceStatusBodySchema.safeParse({ status: "cancelled" }).success).toBe(false));
  it("campo extra → falla (strict)", () => expect(updateInvoiceStatusBodySchema.safeParse({ status: "paid", x: 1 }).success).toBe(false));
});

// ── pushSubscribeBodySchema ───────────────────────────────────────────────────

describe("pushSubscribeBodySchema", () => {
  const valid = {
    endpoint: "https://push.example.com/subscription/abc123",
    keys: { p256dh: "p256dhkeyvalue1234567890abcdef", auth: "authvalue1234" },
  };
  it("suscripción válida → parsea", () => expect(pushSubscribeBodySchema.safeParse(valid).success).toBe(true));
  it("con deviceLabel → parsea", () => {
    expect(pushSubscribeBodySchema.safeParse({ ...valid, deviceLabel: "Mi Android" }).success).toBe(true);
  });
  it("endpoint vacío → falla", () => {
    expect(pushSubscribeBodySchema.safeParse({ ...valid, endpoint: "" }).success).toBe(false);
  });
  it("p256dh vacío → falla", () => {
    expect(pushSubscribeBodySchema.safeParse({ ...valid, keys: { p256dh: "", auth: "x" } }).success).toBe(false);
  });
  it("auth vacío → falla", () => {
    expect(pushSubscribeBodySchema.safeParse({ ...valid, keys: { p256dh: "x", auth: "" } }).success).toBe(false);
  });
  it("keys con campo extra → falla (strict en keys)", () => {
    expect(pushSubscribeBodySchema.safeParse({ ...valid, keys: { ...valid.keys, extra: "x" } }).success).toBe(false);
  });
  it("campo extra → falla (strict)", () => {
    expect(pushSubscribeBodySchema.safeParse({ ...valid, extra: "x" }).success).toBe(false);
  });
});

// ── supervisorResponseSchema ──────────────────────────────────────────────────

describe("supervisorResponseSchema", () => {
  it("kind 'answer' con answer → parsea", () => {
    expect(supervisorResponseSchema.safeParse({ kind: "answer", answer: "Hola" }).success).toBe(true);
  });
  it("kind 'actions' con actions → parsea", () => {
    expect(supervisorResponseSchema.safeParse({
      kind: "actions",
      actions: [{ intent: "answer", data: {}, summary: "Respondiendo" }],
    }).success).toBe(true);
  });
  it("kind 'notification' con notification level 'now' → parsea", () => {
    expect(supervisorResponseSchema.safeParse({
      kind: "notification",
      notification: { level: "now", title: "Alerta", body: "Stock bajo" },
    }).success).toBe(true);
  });
  it("kind 'clarification' con clarification → parsea", () => {
    expect(supervisorResponseSchema.safeParse({
      kind: "clarification",
      clarification: { question: "¿Qué producto?", context: "Ajuste de stock" },
    }).success).toBe(true);
  });
  it("kind inválido → falla", () => {
    expect(supervisorResponseSchema.safeParse({ kind: "unknown_kind" }).success).toBe(false);
  });
  it("intent hallucinated → falla", () => {
    expect(supervisorResponseSchema.safeParse({
      kind: "actions",
      actions: [{ intent: "hallucinated_intent", data: null, summary: "x" }],
    }).success).toBe(false);
  });
  it("notification level inválido → falla", () => {
    expect(supervisorResponseSchema.safeParse({
      kind: "notification",
      notification: { level: "urgent" },
    }).success).toBe(false);
  });
  it("todos los notification levels válidos", () => {
    for (const level of ["now", "daily", "drop"] as const) {
      expect(supervisorResponseSchema.safeParse({ kind: "notification", notification: { level } }).success).toBe(true);
    }
  });
});
