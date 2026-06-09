// src/lib/mcp/_lib/sales-backend.port.ts — Backend-agnostic port for the sales MCP tool pack.
//
// Decouples the three hardcoded sales write tools from Velora's concrete use-case layer.
// A future TiendaNubeSalesAdapter (or any other backend) implements this interface
// and requires ZERO changes to sales-tools.ts or the MCP server.
//
// Design mirrors catalog-backend.port.ts exactly:
//   port (this file) → adapter (VeloraSalesAdapter in sales-backend.factory.ts)
//                    → factory (createSalesBackend in sales-backend.factory.ts)
//
// The promesa tools (register_promesa_sale, confirm_promesa_payment,
// settle_promesa_payment) already have their own createPromesaBackend() seam —
// they are intentionally NOT included here.
//
// Input/output types are intentionally narrow (tool-contract shapes), not full
// domain types. The port is a seam, not a domain model.

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

// ── register_sale ─────────────────────────────────────────────────────────────

export interface RegisterSaleInput {
  businessId: string;
  items: Array<{ productId: string; quantity: number; unitPrice?: number }>;
  customerId?: string;
  paymentMethod?: string;
  /** When supplied, folded into the server-side idempotency hash to force a distinct sale. */
  requestId?: string;
}

// ── register_movement ─────────────────────────────────────────────────────────

export interface RegisterMovementInput {
  businessId: string;
  type: string;
  description: string;
  amount: number;
  date?: string;
}

// ── return_sale ───────────────────────────────────────────────────────────────

export interface ReturnSaleInput {
  businessId: string;
  count: number;
  cutoffHours: number;
}

/**
 * Backend-agnostic sales port for the MCP sales tool pack.
 *
 * Covers the three write tools that were previously hardcoded to Velora's
 * use-case layer: register_sale, register_movement, return_sale.
 *
 * Each method returns CallToolResult so sales-tools.ts can forward the result
 * directly to the MCP framework without any translation.
 *
 * Tenant isolation is enforced by each adapter via businessId on every input.
 * Throws or returns isError:true for error paths — sales-tools.ts forwards both.
 *
 * The promesa tools live behind createPromesaBackend() and are NOT part of this port.
 */
export interface SalesBackend {
  registerSale(input: RegisterSaleInput): Promise<CallToolResult>;
  registerMovement(input: RegisterMovementInput): Promise<CallToolResult>;
  returnSale(input: ReturnSaleInput): Promise<CallToolResult>;
}
