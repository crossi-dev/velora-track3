// ventas-agent-tools.ts — FunctionTool factories for the Ventas ADK agent.
//
// Pattern C: every tool returns a structured intent { intent, data, summary }
// instead of executing a mutation. The handler downstream (owner-handler.ts via
// agent-call-actions.ts) materializes the intents through the existing
// idempotent + audited mutation pipeline. Schemas mirror the data shapes
// expected by supervisor-action-mapper.ts so the downstream pipeline does not
// need to change.

import { z } from "zod/v3";
import { FunctionTool } from "@google/adk";

// ── Factory ──────────────────────────────────────────────────────────────────

interface IntentResult<T = unknown> {
  intent: string;
  data: T;
  summary: string;
}

// Builds an intent-emitting tool. The execute fn never mutates state — it just
// returns the structured intent the RPC handler captures and forwards.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- ADK ships a nested zod copy with nominally distinct types; the cast happens at the SDK boundary only.
function buildIntentTool<S extends z.ZodSchema<any>>(opts: {
  name: string;
  description: string;
  schema: S;
  summary: (input: z.infer<S>) => string;
}): FunctionTool {
  return new FunctionTool({
    name: opts.name,
    description: opts.description,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- same SDK-boundary cast as above.
    parameters: opts.schema as any,
    execute: async (input) => {
      const parsed = input as z.infer<S>;
      const result: IntentResult<z.infer<S>> = {
        intent: opts.name,
        data: parsed,
        summary: opts.summary(parsed),
      };
      return result;
    },
  });
}

// ── Sales tools ──────────────────────────────────────────────────────────────

const registerSaleParams = z.object({
  productName: z.string().describe("Product name as the owner referred to it"),
  customerName: z.string().describe("Customer name; use 'Consumidor Final' when none was mentioned"),
  qty: z.number().optional().describe("Quantity sold (default 1 when not mentioned)"),
  unitPrice: z.number().optional().describe("Custom unit price in ARS when the owner states a price different from the catalog. Omit to use the catalog price."),
  autoSend: z.boolean().optional().describe("True when the owner explicitly asked to send the sale receipt via WhatsApp"),
});

const returnSaleParams = z.object({
  undoCount: z.number().int().min(1).max(10).describe("How many recent sales to undo (1-10, default 1)"),
});

// ── Catalog tools ────────────────────────────────────────────────────────────

const createProductParams = z.object({
  name: z.string(),
  price: z.number(),
  stock: z.number().nullable().describe("Initial stock; null when the owner did not provide one"),
});

const editProductParams = z.object({
  productName: z.string(),
  field: z.enum(["price", "costPrice", "stock", "name"]).describe("Which product field to update"),
  value: z.union([z.string(), z.number()]).describe("New value (number for price/costPrice/stock, string for name)"),
});

const deleteProductParams = z.object({
  productName: z.string(),
});

const bulkPriceUpdateParams = z.object({
  amount: z.number(),
  mode: z.enum(["percentage", "absolute"]),
  direction: z.enum(["up", "down", "set"]),
  target: z.string().describe("'all' or a product/category name. 'all' applies to the whole catalog."),
});

// ── Stock tools ──────────────────────────────────────────────────────────────

const adjustStockParams = z.object({
  productName: z.string(),
  mode: z.enum(["set", "increase", "decrease"]),
  quantity: z.number(),
});

const stockLoadParams = z.object({
  itemName: z.string(),
  quantity: z.number().nullable(),
  unitPrice: z.number().nullable(),
  supplierName: z.string().describe("Supplier; empty string when the owner did not mention one"),
});

// ── Cash tools ───────────────────────────────────────────────────────────────

const registerMovementParams = z.object({
  movementType: z.enum(["purchase", "income", "salary", "adjustment", "tax"]).describe(
    "Spanish synonyms (gasto/ingreso/sueldo/retiro) are normalised downstream — use English here.",
  ),
  amount: z.number(),
  description: z.string(),
});

// ── Customer tools ───────────────────────────────────────────────────────────

const createCustomerParams = z.object({
  name: z.string(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  taxId: z.string().nullable().describe("CUIT/CUIL if mentioned"),
});

const editCustomerParams = z.object({
  customerName: z.string(),
  field: z.enum(["name", "phone", "email", "taxId", "address", "postalCode"]),
  value: z.string(),
});

// ── Supplier tools ───────────────────────────────────────────────────────────

const createSupplierParams = z.object({
  name: z.string(),
  phone: z.string().describe("Empty string when not provided"),
  email: z.string().describe("Empty string when not provided"),
  contactName: z.string().describe("Empty string when not provided"),
});

const editSupplierParams = z.object({
  supplierName: z.string(),
  field: z.enum(["name", "phone", "email", "contactName"]),
  value: z.string(),
});

const deleteSupplierParams = z.object({
  supplierName: z.string(),
});

const deleteCustomerParams = z.object({
  customerName: z.string(),
});

// ── Purchase request tools ──────────────────────────────────────────────────

const createPurchaseRequestParams = z.object({
  supplierName: z.string().describe("Supplier; empty string when not mentioned"),
  itemName: z.string(),
  quantity: z.number().nullable(),
  unitPrice: z.number().nullable(),
});

// ── Tool exports ─────────────────────────────────────────────────────────────

export function buildVentasTools(): FunctionTool[] {
  return [
    buildIntentTool({
      name: "register_sale", description: "Records a sale of a product to a customer.",
      schema: registerSaleParams,
      summary: (d) => `Venta: ${d.qty != null ? `${d.qty}x ` : ""}${d.productName}${d.unitPrice != null ? ` @$${d.unitPrice}` : ""} a ${d.customerName}${d.autoSend ? " (WhatsApp)" : ""}`,
    }),
    buildIntentTool({
      name: "return_sale", description: "Undoes the N most recent sales.",
      schema: returnSaleParams,
      summary: (d) => `Deshacer ${d.undoCount === 1 ? "última venta" : `últimas ${d.undoCount} ventas`}`,
    }),
    buildIntentTool({
      name: "create_product", description: "Adds a new product to the catalog.",
      schema: createProductParams,
      summary: (d) => `Crear producto: ${d.name} a $${d.price}${d.stock !== null ? ` con ${d.stock} de stock` : ""}`,
    }),
    buildIntentTool({
      name: "edit_product", description: "Edits a single field of an existing product.",
      schema: editProductParams,
      summary: (d) => `${d.productName}: ${d.field} → ${d.value}`,
    }),
    buildIntentTool({
      name: "delete_product", description: "Removes a product from the catalog.",
      schema: deleteProductParams,
      summary: (d) => `Eliminar producto: ${d.productName}`,
    }),
    buildIntentTool({
      name: "bulk_price_update", description: "Applies a bulk price change to one product, a group, or the entire catalog.",
      schema: bulkPriceUpdateParams,
      summary: (d) => `${d.direction === "up" ? "Subir" : d.direction === "down" ? "Bajar" : "Setear"} precio ${d.target}: ${d.amount}${d.mode === "percentage" ? "%" : " $"}`,
    }),
    buildIntentTool({
      name: "adjust_stock", description: "Sets, increases, or decreases stock for a product.",
      schema: adjustStockParams,
      summary: (d) => `Stock ${d.productName}: ${d.mode} ${d.quantity}`,
    }),
    buildIntentTool({
      name: "stock_load", description: "Records inbound stock from a supplier (purchase / restock).",
      schema: stockLoadParams,
      summary: (d) => `Cargar stock: ${d.quantity ?? "?"} ${d.itemName}${d.supplierName ? ` de ${d.supplierName}` : ""}`,
    }),
    buildIntentTool({
      name: "register_movement", description: "Records a cash movement (expense, income, salary, adjustment, tax).",
      schema: registerMovementParams,
      summary: (d) => `Caja ${d.movementType}: $${d.amount} — ${d.description}`,
    }),
    buildIntentTool({
      name: "create_customer", description: "Adds a new customer.",
      schema: createCustomerParams,
      summary: (d) => `Nuevo cliente: ${d.name}`,
    }),
    buildIntentTool({
      name: "edit_customer", description: "Edits a single field of an existing customer.",
      schema: editCustomerParams,
      summary: (d) => `Cliente ${d.customerName}: ${d.field} → ${d.value}`,
    }),
    buildIntentTool({
      name: "create_supplier", description: "Adds a new supplier (upserts if the name already exists).",
      schema: createSupplierParams,
      summary: (d) => `Nuevo proveedor: ${d.name}`,
    }),
    buildIntentTool({
      name: "edit_supplier", description: "Edits a single field of an existing supplier.",
      schema: editSupplierParams,
      summary: (d) => `Proveedor ${d.supplierName}: ${d.field} → ${d.value}`,
    }),
    buildIntentTool({
      name: "delete_supplier", description: "Removes a supplier.",
      schema: deleteSupplierParams,
      summary: (d) => `Eliminar proveedor: ${d.supplierName}`,
    }),
    buildIntentTool({
      name: "delete_customer", description: "Removes a customer (only allowed when the customer has no sale or invoice history).",
      schema: deleteCustomerParams,
      summary: (d) => `Eliminar cliente: ${d.customerName}`,
    }),
    buildIntentTool({
      name: "create_purchase_request",
      description:
        "Creates a purchase request to a supplier (procurement). Use when the owner asks to order/buy/restock items from a supplier. Quantity and unitPrice may be null if the owner did not provide them.",
      schema: createPurchaseRequestParams,
      summary: (d) => `Pedir ${d.quantity ?? "?"} ${d.itemName}${d.supplierName ? ` a ${d.supplierName}` : ""}`,
    }),
  ];
}
