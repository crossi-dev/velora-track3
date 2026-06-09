// ventas-core-tools.schemas.ts — Zod + genai schemas for VENTAS-CORE tools.
//
// Co-located with the tool pack for coherence. Imported by ventas-core-tools.ts.
// Pure data — no DB access, no side-effects, no "server-only" needed.

import { z } from "zod";
import { Type } from "@google/genai";
import type { Schema } from "@google/genai";

// ── registrar_venta ────────────────────────────────────────────────────────────

export const RegistrarVentaInput = z.object({
  productName: z.string().min(1, "productName is required"),
  customerName: z.string().default("Consumidor Final"),
  qty: z.number().positive().optional(),
  unitPrice: z.number().positive().optional(),
  autoSend: z.boolean().optional(),
});

export const REGISTRAR_VENTA_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    productName: { type: Type.STRING, description: "Product name as the owner referred to it." },
    customerName: { type: Type.STRING, description: "Customer name. Use 'Consumidor Final' when none was mentioned." },
    qty: { type: Type.NUMBER, description: "Quantity sold. Defaults to 1 when not mentioned." },
    unitPrice: { type: Type.NUMBER, description: "Custom unit price in ARS. Omit to use catalog price." },
    autoSend: { type: Type.BOOLEAN, description: "True when owner asked to send the receipt via WhatsApp." },
  },
  required: ["productName"],
};

// ── anular_venta ───────────────────────────────────────────────────────────────

export const AnularVentaInput = z.object({
  saleId: z.string().optional(),
  customerDescription: z.string().optional(),
  undoCount: z.number().int().min(1).max(10).optional(),
  reason: z.string().optional(),
});

export const ANULAR_VENTA_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    saleId: { type: Type.STRING, description: "Exact sale ID to cancel. Preferred over description." },
    customerDescription: { type: Type.STRING, description: "Customer name fragment to resolve the sale." },
    undoCount: { type: Type.NUMBER, description: "How many recent sales to undo (1-10). Used when no ID or description is given." },
    reason: { type: Type.STRING, description: "Reason for cancellation (optional, for audit trail)." },
  },
};

// ── devolucion_parcial ─────────────────────────────────────────────────────────

const DevolucionItemSchema = z.object({
  saleItemId: z.string().optional(),
  productName: z.string().optional(),
  quantity: z.number().int().positive(),
  unitPrice: z.number().positive().optional(),
});

const ExchangeItemSchema = z.object({
  productName: z.string().min(1),
  quantity: z.number().int().positive(),
  unitPrice: z.number().positive().optional(),
});

export const DevolucionParcialInput = z.object({
  saleId: z.string().optional(),
  customerDescription: z.string().optional(),
  returnItems: z.array(DevolucionItemSchema).min(1, "At least one return item is required."),
  exchangeItems: z.array(ExchangeItemSchema).optional(),
  reason: z.string().optional(),
});

export const DEVOLUCION_PARCIAL_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    saleId: { type: Type.STRING, description: "Exact sale ID." },
    customerDescription: { type: Type.STRING, description: "Customer name fragment." },
    returnItems: {
      type: Type.ARRAY, description: "Items being returned (min 1).",
      items: { type: Type.OBJECT, properties: { saleItemId: { type: Type.STRING, description: "SaleItem ID (preferred)." }, productName: { type: Type.STRING, description: "Product name fallback." }, quantity: { type: Type.NUMBER, description: "Returned quantity." }, unitPrice: { type: Type.NUMBER, description: "Override price." } }, required: ["quantity"] },
    },
    exchangeItems: {
      type: Type.ARRAY, description: "Replacement items (omit for cash refund).",
      items: { type: Type.OBJECT, properties: { productName: { type: Type.STRING, description: "Replacement product." }, quantity: { type: Type.NUMBER, description: "Replacement qty." }, unitPrice: { type: Type.NUMBER, description: "Override price." } }, required: ["productName", "quantity"] },
    },
    reason: { type: Type.STRING, description: "Reason for the return." },
  },
  required: ["returnItems"],
};

// ── buscar_venta ───────────────────────────────────────────────────────────────

export const BuscarVentaInput = z.object({
  saleId: z.string().optional(),
  customerDescription: z.string().optional(),
  reenviar_comprobante: z.boolean().optional(),
});

export const BUSCAR_VENTA_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    saleId: { type: Type.STRING, description: "Exact sale ID." },
    customerDescription: { type: Type.STRING, description: "Customer name fragment." },
    reenviar_comprobante: { type: Type.BOOLEAN, description: "True to resend the WhatsApp receipt." },
  },
};

// ── presupuesto ────────────────────────────────────────────────────────────────

const PresupuestoLineItemSchema = z.object({
  productName: z.string().min(1),
  quantity: z.number().positive(),
  unitPrice: z.number().positive(),
});

export const PresupuestoInput = z.object({
  items: z.array(PresupuestoLineItemSchema).min(1, "At least one item is required."),
  discountPercentage: z.number().min(0).max(100).optional(),
  taxPercentage: z.number().min(0).max(100).optional(),
  customerName: z.string().optional(),
});

export const PRESUPUESTO_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    items: {
      type: Type.ARRAY, description: "Line items for the quote.",
      items: { type: Type.OBJECT, properties: { productName: { type: Type.STRING, description: "Product name." }, quantity: { type: Type.NUMBER, description: "Quantity." }, unitPrice: { type: Type.NUMBER, description: "Unit price in ARS." } }, required: ["productName", "quantity", "unitPrice"] },
    },
    discountPercentage: { type: Type.NUMBER, description: "Discount % (0-100)." },
    taxPercentage: { type: Type.NUMBER, description: "Tax % (0-100). Default 0 — AR B2C often omits IVA at register." },
    customerName: { type: Type.STRING, description: "Customer name for the quote header." },
  },
  required: ["items"],
};
