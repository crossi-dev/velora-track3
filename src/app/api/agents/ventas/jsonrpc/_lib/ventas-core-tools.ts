// S1-DORMANT — NOT registered in adk-ventas-agent.ts. Do not import for runtime use.
// Deferred to S2. Blockers before activation:
//   CRITICAL-3: by-id void handler missing in undo-dispatcher (handleUndoSale is last-N only)
//   CRITICAL-4: devolucion_parcial.returnItems[].unitPrice must be read from DB, not LLM-provided
//   CRITICAL-5: recordCriticalWriteEvent required for anular_venta + devolucion_parcial (money-destructive)
//
import "server-only";
// ventas-core-tools.ts — VENTAS-CORE tool pack (5 tools via createTool factory).
//
// Tools: registrar_venta · anular_venta · devolucion_parcial · buscar_venta · presupuesto
// Schemas live in ventas-core-tools.backend.ts (co-located with port + adapter).
//
// Mutation tools follow Pattern C: emit { intent, data, summary }, never mutate.
// Read tools (buscar_venta, presupuesto) execute directly — no side-effects.
//
// Sources (pre-verified HTTP 200):
//   Square CreateOrder/SearchOrders/RefundPayment/CalculateOrder/Exchange:
//   https://developer.squareup.com/reference/square/orders-api/

import { createTool } from "@/lib/adk/tools/_shared/create-tool";
import { cloudLog } from "@/lib/cloud-logger";
import { sendCustomerReceipt } from "@/app/api/agents/communications/jsonrpc/_lib/send-customer-receipt";
import {
  type VentasCoreBackend,
  type SaleRow,
  resolveSale,
} from "./ventas-core-tools.backend";
import {
  RegistrarVentaInput, REGISTRAR_VENTA_SCHEMA,
  AnularVentaInput, ANULAR_VENTA_SCHEMA,
  DevolucionParcialInput, DEVOLUCION_PARCIAL_SCHEMA,
  BuscarVentaInput, BUSCAR_VENTA_SCHEMA,
  PresupuestoInput, PRESUPUESTO_SCHEMA,
} from "./ventas-core-tools.schemas";

export type { VentasCoreBackend };
export { createVentasCoreBackend } from "./ventas-core-tools.backend";

export interface VentasCoreToolContext {
  backend: VentasCoreBackend;
}

// ── 1. ventas.registrar_venta ──────────────────────────────────────────────────
// Pattern C intent. Source: Square CreateOrder line_items shape.

export function createRegistrarVentaTool(ctx: VentasCoreToolContext) {
  return createTool({
    name: "ventas.registrar_venta",
    description: "Records a sale of a product to a customer. Emits a structured intent — does not mutate state.",
    schema: REGISTRAR_VENTA_SCHEMA,
    inputSchema: RegistrarVentaInput,
    backend: ctx,
    execute: async ({ input }) => {
      const parts = [
        input.qty != null ? `${input.qty}x ` : "",
        input.productName,
        input.unitPrice != null ? ` @$${input.unitPrice}` : "",
        ` a ${input.customerName}`,
        input.autoSend ? " (WhatsApp)" : "",
      ];
      return {
        intent: "ventas.registrar_venta",
        data: { productName: input.productName, customerName: input.customerName, qty: input.qty ?? 1, unitPrice: input.unitPrice ?? null, autoSend: input.autoSend ?? false },
        summary: `Venta: ${parts.join("")}`,
      };
    },
  });
}

// ── 2. ventas.anular_venta ────────────────────────────────────────────────────
// FIX: by-id / by-description resolver on top of last-N undo.
// Source: Square CancelPayment (no single "void order" endpoint).
// Money → idempotency + audit handled by undo/route.ts downstream.

export function createAnularVentaTool(ctx: VentasCoreToolContext) {
  return createTool({
    name: "ventas.anular_venta",
    description: "Cancels a sale by ID, customer name fragment, or last N. Emits a structured intent — does not mutate state.",
    schema: ANULAR_VENTA_SCHEMA,
    inputSchema: AnularVentaInput,
    backend: ctx.backend,
    execute: async ({ input, backend }) => {
      const resolved = await resolveSale(backend, input.saleId, input.customerDescription);
      if (resolved) {
        const label = resolved.customer?.name ?? "Consumidor Final";
        return {
          intent: "ventas.anular_venta",
          data: { resolvedSaleId: resolved.id, resolvedCustomerName: label, resolvedTotal: resolved.totalAmount, reason: input.reason ?? null, undoCount: null },
          summary: `Anular venta ${resolved.id} — ${label} $${resolved.totalAmount.toFixed(0)}`,
        };
      }
      const count = input.undoCount ?? 1;
      return {
        intent: "ventas.anular_venta",
        data: { resolvedSaleId: null, resolvedCustomerName: null, resolvedTotal: null, reason: input.reason ?? null, undoCount: count },
        summary: count === 1 ? "Anular última venta" : `Anular últimas ${count} ventas`,
      };
    },
  });
}

// ── 3. ventas.devolucion_parcial ───────────────────────────────────────────────
// Composite: refund returned items + optional new order for exchange + settle delta.
// Source: https://developer.squareup.com/docs/orders-api/order-returns-exchanges
// Money → idempotency handled downstream.

export function createDevolucionParcialTool(ctx: VentasCoreToolContext) {
  return createTool({
    name: "ventas.devolucion_parcial",
    description: "Partial refund by line item, with optional exchange. Emits a structured intent — does not mutate state.",
    schema: DEVOLUCION_PARCIAL_SCHEMA,
    inputSchema: DevolucionParcialInput,
    backend: ctx.backend,
    execute: async ({ input, backend }) => {
      const resolved: SaleRow | null = await resolveSale(backend, input.saleId, input.customerDescription);
      const customerLabel = resolved?.customer?.name ?? "cliente";
      const returnLabels = input.returnItems.map((r) => `${r.quantity}x ${r.productName ?? r.saleItemId ?? "item"}`).join(", ");
      const hasExchange = (input.exchangeItems?.length ?? 0) > 0;
      return {
        intent: "ventas.devolucion_parcial",
        data: {
          resolvedSaleId: resolved?.id ?? null,
          returnItems: input.returnItems,
          exchangeItems: input.exchangeItems ?? [],
          reason: input.reason ?? null,
          // "refund_only": straight refund. "compute_downstream": handler creates exchange order + settles delta.
          deltaDirection: hasExchange ? "compute_downstream" : "refund_only",
        },
        summary: `Devolución${resolved ? ` venta ${resolved.id}` : ""} — ${customerLabel}: ${returnLabels}${hasExchange ? " (cambio)" : ""}`,
      };
    },
  });
}

// ── 4. ventas.buscar_venta ────────────────────────────────────────────────────
// READ-ONLY. Source: Square SearchOrders customer_filter + date_time_filter.
// Receipt resend delegates to Communications agent via direct import.

export function createBuscarVentaTool(ctx: VentasCoreToolContext) {
  return createTool({
    name: "ventas.buscar_venta",
    description: "Looks up a sale by ID or customer name. Optionally resends the WhatsApp receipt.",
    schema: BUSCAR_VENTA_SCHEMA,
    inputSchema: BuscarVentaInput,
    backend: ctx.backend,
    execute: async ({ input, backend }) => {
      const sale = await resolveSale(backend, input.saleId, input.customerDescription);
      if (!sale) return { error: { code: "NOT_FOUND", message: "No se encontró la venta." } };

      const base = {
        saleId: sale.id, date: sale.date.toISOString(), status: sale.status,
        totalAmount: sale.totalAmount, customerName: sale.customer?.name ?? null,
        items: sale.saleItems.map((i) => ({ productName: i.product?.name ?? null, quantity: i.quantity, unitPrice: i.unitPrice })),
        receiptResent: false as boolean, receiptNote: undefined as string | undefined,
      };

      if (!input.reenviar_comprobante) return base;
      if (!sale.customerId) return { ...base, receiptNote: "NO_CUSTOMER_ON_SALE" };
      const customer = await backend.findCustomerById(sale.customerId);
      if (!customer?.phone) return { ...base, receiptNote: "CUSTOMER_HAS_NO_PHONE" };

      const claimed = await backend.claimReceiptStamp(sale.id);
      if (!claimed) return { ...base, receiptResent: true, receiptNote: "ALREADY_SENT_PREVIOUSLY" };

      try {
        await sendCustomerReceipt({ businessId: backend.businessId, customerPhone: customer.phone, customerName: customer.name, paymentIntentId: sale.id, monto: sale.totalAmount });
        return { ...base, receiptResent: true };
      } catch (err) {
        await backend.releaseReceiptStamp(sale.id);
        const msg = err instanceof Error ? err.message : String(err);
        cloudLog({ severity: "WARNING", component: "A2A", action: "VENTAS_REENVIAR_COMPROBANTE_FAILED", a2a_transfer: false, message: `reenviar_comprobante failed for sale ${sale.id}: ${msg}`, data: { saleId: sale.id }, businessId: backend.businessId });
        return { ...base, receiptNote: `SEND_FAILED: ${msg}` };
      }
    },
  });
}

// ── 5. ventas.presupuesto ─────────────────────────────────────────────────────
// PURE COMPUTE. Source: Square CalculateOrder (preview without persist).
// AR: presupuesto does NOT trigger ARCA fiscal number.

export function createPresupuestoTool(ctx: VentasCoreToolContext) {
  return createTool({
    name: "ventas.presupuesto",
    description: "Calculates a price quote with optional discount and tax. Does NOT create a sale.",
    schema: PRESUPUESTO_SCHEMA,
    inputSchema: PresupuestoInput,
    backend: ctx,
    execute: async ({ input }) => {
      const subtotal = input.items.reduce((sum: number, i) => sum + i.quantity * i.unitPrice, 0);
      const discountAmt = subtotal * ((input.discountPercentage ?? 0) / 100);
      const afterDiscount = subtotal - discountAmt;
      const taxAmt = afterDiscount * ((input.taxPercentage ?? 0) / 100);
      const total = afterDiscount + taxAmt;
      return {
        customerName: input.customerName ?? null,
        items: input.items.map((i) => ({ productName: i.productName, quantity: i.quantity, unitPrice: i.unitPrice, lineTotal: +(i.quantity * i.unitPrice).toFixed(2) })),
        subtotal: +subtotal.toFixed(2), discountPercentage: input.discountPercentage ?? 0, discountAmount: +discountAmt.toFixed(2),
        taxPercentage: input.taxPercentage ?? 0, taxAmount: +taxAmt.toFixed(2), total: +total.toFixed(2),
        currency: "ARS",
        note: "Presupuesto sin persistir. Confirmá con ventas.registrar_venta para registrar la venta.",
      };
    },
  });
}

// ── Composite builder ─────────────────────────────────────────────────────────

export function buildVentasCoreTools(ctx: VentasCoreToolContext) {
  return [
    createRegistrarVentaTool(ctx),
    createAnularVentaTool(ctx),
    createDevolucionParcialTool(ctx),
    createBuscarVentaTool(ctx),
    createPresupuestoTool(ctx),
  ];
}
