// src/lib/mcp/_lib/sales-mutations.ts — Handlers for sales-tools.ts (Batch 4 money).
//
// register_sale  : creates a full sale via createSaleUseCase (cascade: items +
//                  inventory.decrement + stock-movement + cash-movement + invoice).
// register_movement : records a cash movement via createCashMovementUseCase.
//
// SECURITY: businessId ALWAYS from the closure — NEVER from tool input.
// Every DB lookup that uses a caller-supplied ID (productId, customerId) is
// qualified by the closure businessId inside the use-case (tenant isolation).
//
// Idempotency: all mutations go through beginIdempotentMutation via the
// canonical use-case ports. Double-call with the same args → "replayed" outcome,
// no second write.
//
// MONEY-PATH PRICE GUARD (MCP surface — owner path):
//   unitPrice is OPTIONAL on the MCP tool input. When omitted, the catalog price
//   from the DB is used (NABAOS invariant: monetary values from DB rows, not LLM).
//   When supplied, it is validated against the catalog price via detectPriceOutlier
//   (same 50% threshold as the employee path, DEFAULT_PRICE_OUTLIER_THRESHOLD).
//   Deviations beyond 50% are REJECTED with PRICE_OUTLIER — unlike the owner chat
//   path (which soft-warns and uses a confirmation modal), the MCP surface has no
//   human confirmation step, so the guard must be hard.
//
// References:
//   create-sale.use-case       — src/application/use-cases/create-sale.use-case.ts
//   create-cash-movement.use-case — src/application/use-cases/create-cash-movement.use-case.ts

import { createSaleUseCase } from "@/application/use-cases/create-sale.use-case";
import { createCashMovementUseCase } from "@/application/use-cases/create-cash-movement.use-case";
import type { CashMovementType } from "@/domain/ports/cash-movement.repository.port";
import { prismaBusinessRepository } from "@/infrastructure/persistence/prisma-business.repository";
import { prismaSaleRepository } from "@/infrastructure/persistence/prisma-sale.repository";
import { prismaInventoryRepository } from "@/infrastructure/persistence/prisma-inventory.repository";
import { prismaCashMovementRepository } from "@/infrastructure/persistence/prisma-cash-movement.repository";
import { prismaIdempotencyAdapter } from "@/infrastructure/persistence/prisma-idempotency.adapter";
import { prismaAuditAdapter } from "@/infrastructure/persistence/prisma-audit.adapter";
import { prismaTransactionAdapter } from "@/infrastructure/persistence/prisma-transaction.adapter";
import { getServerActionMeta } from "@/app/api/_lib/mutation-contract";
import { normalizeCustomerName, CONSUMIDOR_FINAL_NAME } from "@/infrastructure/shared/sale-customer";
import { resolveCatalogPrices } from "./sale-price-guard";
import { triggerFiscalIfTaxId } from "@/app/api/sales/create/sale-post-commit";
import type { InvoicePayload } from "@/infrastructure/shared/invoice-document";
import { reportError } from "@/lib/cloud-logger";
import { createHash } from "crypto";
import { errResponse } from "./mcp-responses";

// ── Action metas (from canonical mutation contract) ────────────────────────────

export const SALE_CREATE_ACTION = getServerActionMeta("sale.create");
export const CASH_MOVEMENT_CREATE_ACTION = getServerActionMeta("cash-movement.create");

// ── Use-case instances ─────────────────────────────────────────────────────────

export const saleUseCase = createSaleUseCase({
  business: prismaBusinessRepository,
  sale: prismaSaleRepository,
  inventory: prismaInventoryRepository,
  idempotency: prismaIdempotencyAdapter,
  audit: prismaAuditAdapter,
  transaction: prismaTransactionAdapter,
});

export const cashMovementUseCase = createCashMovementUseCase({
  cashMovements: prismaCashMovementRepository,
  idempotency: prismaIdempotencyAdapter,
  audit: prismaAuditAdapter,
  transaction: prismaTransactionAdapter,
});

// ── MCP actor constant + shared utilities ──────────────────────────────────────

/** MCP-originated mutations carry this userId for audit trail attribution. */
export const MCP_ACTOR_USER_ID = "mcp-system";

export function mkIdemKey(businessId: string, tool: string, ...parts: (string | number | null | undefined)[]): string {
  return [businessId, tool, ...parts.map((p) => String(p ?? ""))].join(":");
}

/** Build a content-addressed idempotency key for a sale from its stable args.
 *  When requestId is supplied it is folded into the hash so two legitimate same-basket
 *  sales can be recorded without dedup collision. The key remains SERVER-DERIVED.
 *  NOTE: resolved (catalog-derived) unitPrices are used here so the key is stable
 *  whether the caller omitted unitPrice or supplied the catalog price explicitly. */
export function buildSaleIdemKey(
  businessId: string,
  items: Array<{ productId: string; quantity: number; unitPrice: number }>,
  customerId: string | null,
  requestId?: string,
): string {
  const sortedItems = [...items]
    .sort((a, b) => a.productId.localeCompare(b.productId))
    .map((i) => `${i.productId}:${i.quantity}:${i.unitPrice}`)
    .join("|");
  const raw = `${businessId}|${customerId ?? ""}|${sortedItems}|${requestId ?? ""}`;
  return "mcp-sale-" + createHash("sha256").update(raw).digest("hex").slice(0, 24);
}

// ── Tool response type ─────────────────────────────────────────────────────────

type McpToolResponse = { content: { type: "text"; text: string }[]; isError?: boolean };

// ── register_sale ──────────────────────────────────────────────────────────────

export interface RegisterSaleArgs {
  items: Array<{ productId: string; quantity: number; unitPrice?: number }>;
  customerId?: string;
  paymentMethod?: string;
  /** When supplied, folded into the server-side idempotency hash to force a distinct sale. */
  requestId?: string;
}

export async function handleRegisterSale(
  businessId: string,
  args: RegisterSaleArgs,
): Promise<McpToolResponse> {
  try {
    if (!args.items || args.items.length === 0) {
      return errResponse("REGISTER_SALE_VALIDATION", "At least one item is required.");
    }
    for (const item of args.items) {
      if (!item.productId?.trim()) return errResponse("REGISTER_SALE_VALIDATION", "Each item must have a non-empty productId.");
      if (!Number.isInteger(item.quantity) || item.quantity <= 0) return errResponse("REGISTER_SALE_VALIDATION", "Each item quantity must be a positive integer.");
      // unitPrice is now optional — omit to use catalog price; validate below if supplied.
      if (item.unitPrice !== undefined && (typeof item.unitPrice !== "number" || item.unitPrice <= 0)) {
        return errResponse("REGISTER_SALE_VALIDATION", "When unitPrice is supplied it must be a positive number.");
      }
    }

    // ── Catalog price resolution + MCP money-path guard ────────────────────
    // NABAOS M2: monetary values must come from DB rows, not LLM output.
    // When unitPrice is omitted → use catalog price.
    // When supplied → validate against catalog; reject if deviation > 50%.
    const catalogResult = await resolveCatalogPrices(businessId, args.items);
    if (!catalogResult.ok) {
      if (catalogResult.code === "PRODUCT_NOT_OWNED") {
        return errResponse("PRODUCT_NOT_OWNED", `Product ${catalogResult.productId} does not belong to this business.`);
      }
      if (catalogResult.code === "CATALOG_PRICE_INVALID") {
        return errResponse(
          "CATALOG_PRICE_INVALID",
          `Product "${catalogResult.productName}" has no valid catalog price. Set a price for it in Velora before selling.`,
        );
      }
      // PRICE_OUTLIER
      return errResponse(
        "PRICE_OUTLIER",
        `Price for "${catalogResult.productName}" is ${catalogResult.direction} catalog (catalog: ${catalogResult.catalogPrice}, supplied: ${catalogResult.suppliedPrice}). Omit unitPrice to use catalog price, or supply a price within 50% of catalog.`,
      );
    }

    const resolvedItems = catalogResult.items;
    const customerId = args.customerId?.trim() || null;
    const idemKey = buildSaleIdemKey(businessId, resolvedItems, customerId, args.requestId);

    const result = await saleUseCase.execute({
      businessId,
      actorUserId: MCP_ACTOR_USER_ID,
      actorEmployeeId: null,
      actorRole: "owner",
      customerId,
      items: resolvedItems,
      fallbackCustomerName: CONSUMIDOR_FINAL_NAME,
      normalizedFallbackCustomerName: normalizeCustomerName(CONSUMIDOR_FINAL_NAME),
      idempotencyKey: idemKey,
      actionMeta: SALE_CREATE_ACTION,
      requestBody: args,
      paymentMethod: args.paymentMethod ?? "efectivo",
    });

    if (result.outcome === "replayed") return { content: [{ type: "text", text: JSON.stringify(result.body) }] };
    if (result.outcome === "demo_limit_reached") return errResponse("DEMO_LIMIT_REACHED", result.message);
    if (result.outcome === "idempotency_missing") return errResponse("IDEMPOTENCY_MISSING", "Missing idempotency key.");
    if (result.outcome === "idempotency_conflict") return errResponse("IDEMPOTENCY_CONFLICT", "Idempotency key conflict.");
    if (result.outcome === "idempotency_in_flight") return errResponse("IDEMPOTENCY_IN_FLIGHT", "Concurrent operation in progress.");
    if (result.outcome === "business_not_found") return errResponse("BUSINESS_NOT_FOUND", "Business not found.");
    if (result.outcome === "sale_date_future") return errResponse("SALE_DATE_FUTURE", "Sale date is in the future.");
    if (result.outcome === "entity_deleted") return errResponse("ENTITY_DELETED", `Referenced entities deleted: ${result.missing.join(", ")}`);
    if (result.outcome === "customer_not_found") return errResponse("CUSTOMER_NOT_FOUND", "Customer not found in this business.");
    if (result.outcome === "invalid_item_quantity") return errResponse("INVALID_ITEM_QUANTITY", "Each item quantity must be greater than zero.");
    if (result.outcome === "product_not_owned") return errResponse("PRODUCT_NOT_OWNED", "One or more products do not belong to this business.");
    if (result.outcome === "insufficient_stock") return errResponse("INSUFFICIENT_STOCK", `Insufficient stock for ${result.productName}. Available: ${result.available}.`);
    if (result.outcome === "price_outlier") return errResponse("PRICE_OUTLIER", `Price is ${result.direction} expected (${result.expected}).`);
    // exhaustive guard — outcome is "created" at this point
    if (result.outcome !== "created") return errResponse("REGISTER_SALE_ERROR", `Unexpected outcome: ${String((result as { outcome: unknown }).outcome)}`);

    const { data } = result;

    // Real ARCA/AFIP fiscal emission for the MCP surface.
    //
    // The REST route (src/app/api/sales/create/route.ts) triggers CAE emission via
    // firePostCommitActions → triggerFiscalIfTaxId. The MCP register_sale path shares
    // the same createSaleUseCase but historically stopped at the local Invoice row and
    // never triggered the fiscal agent — so a sale registered through Claude/ChatGPT/
    // WhatsApp never received a real comprobante even for a customer with a CUIT on file.
    //
    // We reuse ONLY triggerFiscalIfTaxId (not the whole post-commit bundle) so the MCP
    // path gains fiscal emission WITHOUT inheriting the REST path's other side effects
    // (owner chat confirmation, customer WhatsApp auto-send, payments/logistica agents,
    // low-stock alerts) that the MCP surface intentionally does not perform. The function
    // self-gates: no taxId → skip; async payment (qr/transferencia) → defer to webhook;
    // caeCode already present → skip (idempotent). Fire-and-forget after commit, matching
    // the MCP return_sale post-commit pattern — the sale is already durably recorded, so a
    // fiscal-agent failure must not fail the tool response.
    void triggerFiscalIfTaxId(
      businessId,
      data.sale.id,
      data.invoice.id,
      data.invoice.payload as InvoicePayload,
      args.paymentMethod ?? "efectivo",
    ).catch((err) => reportError(err, { scope: "mcp.register-sale.fiscal-agent" }));

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          saleId: data.sale.id,
          totalAmount: data.sale.totalAmount,
          status: data.sale.status,
          invoiceId: data.invoice.id,
        }),
      }],
    };
  } catch (err) {
    return errResponse("REGISTER_SALE_ERROR", err instanceof Error ? err.message : "Unknown error");
  }
}

// ── register_movement ──────────────────────────────────────────────────────────

export interface RegisterMovementArgs {
  type: CashMovementType;
  description: string;
  amount: number;
  date?: string;
}

export async function handleRegisterMovement(
  businessId: string,
  args: RegisterMovementArgs,
): Promise<McpToolResponse> {
  try {
    if (args.amount <= 0) return errResponse("REGISTER_MOVEMENT_VALIDATION", "Amount must be greater than zero.");
    if (!args.description?.trim()) return errResponse("REGISTER_MOVEMENT_VALIDATION", "Description is required.");

    const date = args.date ? new Date(args.date) : new Date();
    if (isNaN(date.getTime())) return errResponse("REGISTER_MOVEMENT_VALIDATION", "Invalid date format. Use ISO 8601.");

    // Idempotency key derivation:
    //   - When the caller supplies `date`, use it verbatim → stable across retries.
    //   - When `date` is omitted, use the current wall-clock truncated to the minute
    //     (UTC "YYYY-MM-DDTHH:MM"). This prevents two legitimately-different no-date
    //     movements (same type+description+amount) from colliding on the same key.
    //     A true retry within the same UTC minute deduplicates correctly; a second
    //     distinct movement recorded a minute later receives a different key.
    //   Trade-off: two distinct movements with identical fields submitted within the
    //   same UTC minute will collide. This is the standard minute-bucket pattern for
    //   ad-hoc event dedup. Callers that need full discrimination should supply `date`.
    const dateBucket = args.date ?? new Date().toISOString().slice(0, 16); // "YYYY-MM-DDTHH:MM"
    const idemKey = mkIdemKey(businessId, "register_movement", args.type, args.description, String(args.amount), dateBucket);

    const result = await cashMovementUseCase.execute({
      businessId,
      actorUserId: MCP_ACTOR_USER_ID,
      actorEmployeeId: null,
      type: args.type,
      description: args.description.trim(),
      amount: args.amount,
      date,
      idempotencyKey: idemKey,
      actionMeta: CASH_MOVEMENT_CREATE_ACTION,
      requestBody: args,
    });

    if (result.outcome === "replayed") return { content: [{ type: "text", text: JSON.stringify(result.body) }] };
    if (result.outcome === "demo_limit_reached") return errResponse("DEMO_LIMIT_REACHED", result.message);
    if (result.outcome === "idempotency_missing") return errResponse("IDEMPOTENCY_MISSING", "Missing idempotency key.");
    if (result.outcome === "idempotency_conflict") return errResponse("IDEMPOTENCY_CONFLICT", "Idempotency key conflict.");
    if (result.outcome === "idempotency_in_flight") return errResponse("IDEMPOTENCY_IN_FLIGHT", "Concurrent operation in progress.");
    // exhaustive guard — outcome is "created" at this point
    if (result.outcome !== "created") return errResponse("REGISTER_MOVEMENT_ERROR", `Unexpected outcome: ${String((result as { outcome: unknown }).outcome)}`);

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          movementId: result.movement.id,
          type: result.movement.type,
          amount: result.movement.amount,
          description: result.movement.description,
          date: result.movement.date,
          ...(result.signCorrected ? { signCorrected: true } : {}),
        }),
      }],
    };
  } catch (err) {
    return errResponse("REGISTER_MOVEMENT_ERROR", err instanceof Error ? err.message : "Unknown error");
  }
}
