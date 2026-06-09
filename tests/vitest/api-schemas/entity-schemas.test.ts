import { describe, it, expect } from "vitest";
import {
  createCustomerBodySchema,
  updateCustomerBodySchema,
  deleteCustomerBodySchema,
} from "@/app/api/customers/customer-schema";
import { supplierCreateSchema, supplierUpdateSchema } from "@/app/api/suppliers/supplier-schema";
import { createEmployeeBodySchema, deleteEmployeeBodySchema } from "@/app/api/employees/employee-schema";
import { budgetItemSchema, createBudgetBodySchema, deleteBudgetBodySchema } from "@/app/api/budgets/budget-schema";

const VALID_CUID = "abc123def456ghi789jk"; // 20 chars

// ── customers ────────────────────────────────────────────────────────────────

describe("createCustomerBodySchema", () => {
  it("objeto vacío → parsea (todos los campos son opcionales)", () => expect(createCustomerBodySchema.safeParse({}).success).toBe(true));
  it("solo phone → parsea", () => expect(createCustomerBodySchema.safeParse({ phone: "1100000000" }).success).toBe(true));
  it("con name → parsea", () => expect(createCustomerBodySchema.safeParse({ name: "Juan Pérez" }).success).toBe(true));
  it("name vacío → falla (min 1 cuando se provee)", () => expect(createCustomerBodySchema.safeParse({ name: "" }).success).toBe(false));
  it("email inválido → falla", () => expect(createCustomerBodySchema.safeParse({ name: "Ana", email: "no-es-email" }).success).toBe(false));
  it("email válido → parsea", () => expect(createCustomerBodySchema.safeParse({ name: "Ana", email: "juan@ejemplo.com" }).success).toBe(true));
  it("email null → parsea (nullable)", () => expect(createCustomerBodySchema.safeParse({ name: "Ana", email: null }).success).toBe(true));
  it("taxId demasiado largo → falla", () => expect(createCustomerBodySchema.safeParse({ taxId: "x".repeat(31) }).success).toBe(false));
  it("campo extra → falla (strict)", () => expect(createCustomerBodySchema.safeParse({ businessId: "biz" }).success).toBe(false));
});

describe("updateCustomerBodySchema", () => {
  it("solo id → parsea", () => expect(updateCustomerBodySchema.safeParse({ id: VALID_CUID }).success).toBe(true));
  it("con name null → parsea (nullable)", () => expect(updateCustomerBodySchema.safeParse({ id: VALID_CUID, name: null }).success).toBe(true));
  it("id formato inválido → falla", () => expect(updateCustomerBodySchema.safeParse({ id: "INVALID-ID" }).success).toBe(false));
  it("campo extra → falla (strict)", () => expect(updateCustomerBodySchema.safeParse({ id: VALID_CUID, extra: "x" }).success).toBe(false));
});

describe("deleteCustomerBodySchema", () => {
  it("id válido → parsea", () => expect(deleteCustomerBodySchema.safeParse({ id: VALID_CUID }).success).toBe(true));
  it("id vacío → falla", () => expect(deleteCustomerBodySchema.safeParse({ id: "" }).success).toBe(false));
  it("campo extra → falla (strict)", () => expect(deleteCustomerBodySchema.safeParse({ id: VALID_CUID, x: 1 }).success).toBe(false));
});

// ── suppliers ─────────────────────────────────────────────────────────────────

describe("supplierCreateSchema", () => {
  it("objeto vacío → parsea (todos opcionales/nullable)", () => expect(supplierCreateSchema.safeParse({}).success).toBe(true));
  it("nombre largo pero dentro del límite → parsea", () => {
    expect(supplierCreateSchema.safeParse({ name: "Distribuidora San Martín SA" }).success).toBe(true);
  });
  it("email inválido → falla", () => expect(supplierCreateSchema.safeParse({ email: "no-email" }).success).toBe(false));
  it("leadTimeDays negativo → falla (nonnegative)", () => expect(supplierCreateSchema.safeParse({ leadTimeDays: -1 }).success).toBe(false));
  it("leadTimeDays = 365 → parsea (max 365)", () => expect(supplierCreateSchema.safeParse({ leadTimeDays: 365 }).success).toBe(true));
  it("leadTimeDays = 366 → falla (max 365)", () => expect(supplierCreateSchema.safeParse({ leadTimeDays: 366 }).success).toBe(false));
  it("campo extra → falla (strict)", () => expect(supplierCreateSchema.safeParse({ extra: "x" }).success).toBe(false));
});

describe("supplierUpdateSchema", () => {
  it("objeto vacío → parsea (extend con id opcional)", () => expect(supplierUpdateSchema.safeParse({}).success).toBe(true));
  it("con id válido → parsea", () => expect(supplierUpdateSchema.safeParse({ id: VALID_CUID }).success).toBe(true));
  it("id formato inválido → falla", () => expect(supplierUpdateSchema.safeParse({ id: "ABC-INVALID" }).success).toBe(false));
});

// ── employees ─────────────────────────────────────────────────────────────────

describe("createEmployeeBodySchema", () => {
  const valid = { name: "María García", pin: "1234" };
  it("datos válidos → parsea", () => expect(createEmployeeBodySchema.safeParse(valid).success).toBe(true));
  it("nombre vacío → falla", () => expect(createEmployeeBodySchema.safeParse({ ...valid, name: "" }).success).toBe(false));
  it("pin muy corto (3 dígitos) → falla", () => expect(createEmployeeBodySchema.safeParse({ ...valid, pin: "123" }).success).toBe(false));
  it("pin 4 dígitos → parsea", () => expect(createEmployeeBodySchema.safeParse({ ...valid, pin: "0000" }).success).toBe(true));
  it("pin 8 dígitos → parsea", () => expect(createEmployeeBodySchema.safeParse({ ...valid, pin: "12345678" }).success).toBe(true));
  it("pin 9 dígitos → falla", () => expect(createEmployeeBodySchema.safeParse({ ...valid, pin: "123456789" }).success).toBe(false));
  it("pin con letras → falla (regex numérico)", () => expect(createEmployeeBodySchema.safeParse({ ...valid, pin: "12ab" }).success).toBe(false));
  it("campo extra → falla (strict)", () => expect(createEmployeeBodySchema.safeParse({ ...valid, extra: "x" }).success).toBe(false));
});

describe("deleteEmployeeBodySchema", () => {
  it("employeeId válido → parsea", () => expect(deleteEmployeeBodySchema.safeParse({ employeeId: VALID_CUID }).success).toBe(true));
  it("employeeId formato inválido → falla", () => expect(deleteEmployeeBodySchema.safeParse({ employeeId: "SHORT" }).success).toBe(false));
  it("campo extra → falla (strict)", () => expect(deleteEmployeeBodySchema.safeParse({ employeeId: VALID_CUID, x: 1 }).success).toBe(false));
});

// ── budgets ───────────────────────────────────────────────────────────────────

describe("budgetItemSchema", () => {
  const valid = { name: "Laptop", quantity: 2, unitPrice: 1500 };
  it("ítem válido → parsea", () => expect(budgetItemSchema.safeParse(valid).success).toBe(true));
  it("con productId → parsea", () => expect(budgetItemSchema.safeParse({ ...valid, productId: VALID_CUID }).success).toBe(true));
  it("nombre vacío → falla", () => expect(budgetItemSchema.safeParse({ ...valid, name: "" }).success).toBe(false));
  it("quantity decimal → falla (int)", () => expect(budgetItemSchema.safeParse({ ...valid, quantity: 1.5 }).success).toBe(false));
  it("quantity = 0 → falla (positive)", () => expect(budgetItemSchema.safeParse({ ...valid, quantity: 0 }).success).toBe(false));
  it("unitPrice negativo → falla (nonnegative)", () => expect(budgetItemSchema.safeParse({ ...valid, unitPrice: -1 }).success).toBe(false));
  it("unitPrice = 0 → parsea (nonnegative)", () => expect(budgetItemSchema.safeParse({ ...valid, unitPrice: 0 }).success).toBe(true));
  it("campo extra → falla (strict)", () => expect(budgetItemSchema.safeParse({ ...valid, extra: "x" }).success).toBe(false));
});

describe("createBudgetBodySchema", () => {
  const validItem = { name: "Laptop", quantity: 1, unitPrice: 1500 };
  const valid = { items: [validItem] };
  it("mínimo válido → parsea", () => expect(createBudgetBodySchema.safeParse(valid).success).toBe(true));
  it("con customerName y note → parsea", () => {
    expect(createBudgetBodySchema.safeParse({ ...valid, customerName: "Juan", note: "Sin IVA" }).success).toBe(true);
  });
  it("items vacío → falla (min 1)", () => expect(createBudgetBodySchema.safeParse({ items: [] }).success).toBe(false));
  it("campo extra → falla (strict)", () => expect(createBudgetBodySchema.safeParse({ ...valid, extra: "x" }).success).toBe(false));
});

describe("deleteBudgetBodySchema", () => {
  it("budgetId válido → parsea", () => expect(deleteBudgetBodySchema.safeParse({ budgetId: VALID_CUID }).success).toBe(true));
  it("budgetId formato inválido → falla", () => expect(deleteBudgetBodySchema.safeParse({ budgetId: "ABC" }).success).toBe(false));
  it("campo extra → falla (strict)", () => expect(deleteBudgetBodySchema.safeParse({ budgetId: VALID_CUID, x: 1 }).success).toBe(false));
});
