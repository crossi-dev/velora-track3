// src/lib/mcp/_lib/tiendanube-sales.adapter.ts — Tiendanube SalesBackend adapter.
//
// Implements the SalesBackend port against the Tiendanube REST API so that
// register_sale and return_sale operate on a real Tiendanube store.
//
// HTTP client, credential loading, and shared helpers live in tiendanube-ventas.client.ts.
//
// NOT SUPPORTED on Tiendanube (honest errResponse, not fake success):
//   - register_movement: TN has no cash-register ledger concept.
//     This is a Velora-specific cash-book operation with no analog in TN.
//
// MAPPING DECISIONS:
//   - register_sale → POST /orders (maps Velora sale items to TN order line items).
//     paymentMethod is mapped to TN gateway field (advisory — TN validates few values).
//     customerId maps to customer.id in the order body when provided.
//   - return_sale → POST /orders/{id}/cancel (cancels the most recent matching order).
//     TN does not have a native "return" concept; cancel is the closest equivalent.
//     We find the N most recent orders and cancel the first uncancelled one.
//   - Items: Velora uses productId + quantity + unitPrice.
//     TN orders require variant_id, not product_id. We resolve variant_id by fetching
//     the product to get variants[0].id (single-variant catalog assumption — matches
//     the same assumption as the ventas adapter).
//
// Source: tiendanube.github.io/api-documentation (verified 2026-06-08).

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type {
  SalesBackend,
  RegisterSaleInput,
  RegisterMovementInput,
  ReturnSaleInput,
} from "./sales-backend.port";
import { errResponse } from "./mcp-responses";
import {
  loadTiendanubeCredentials,
  tiendanubeBaseUrl,
  tiendanubeRequest,
  type TiendanubeProduct,
  type TiendanubeOrder,
} from "./tiendanube-ventas.client";

// ── Credential guard ──────────────────────────────────────────────────────────

async function requireCredentials(businessId: string) {
  const credentials = await loadTiendanubeCredentials(businessId);
  if (!credentials) {
    return errResponse(
      "TIENDANUBE_NOT_CONNECTED",
      "No Tiendanube credentials found for this business. " +
        "Connect via BusinessChannelCredential with provider='tiendanube'.",
    );
  }
  return credentials;
}

// ── Adapter ────────────────────────────────────────────────────────────────────

/**
 * Tiendanube SalesBackend adapter.
 *
 * Credential setup (one-time per tenant):
 *   encryptCredential(JSON.stringify({ accessToken: "<token>", storeId: "<numericId>" }))
 *   → insert BusinessChannelCredential { businessId, provider: "tiendanube", encryptedCredentials }
 *   → set TenantToolConfig.sales = "tiendanube"
 */
export class TiendanubeSalesAdapter implements SalesBackend {
  // ── register_sale ───────────────────────────────────────────────────────────

  async registerSale(input: RegisterSaleInput): Promise<CallToolResult> {
    const { businessId, items, customerId, paymentMethod } = input;
    const credsOrErr = await requireCredentials(businessId);
    if ("isError" in credsOrErr) return credsOrErr;
    const credentials = credsOrErr;

    // Resolve product → variant id for each item. TN orders use variant_id.
    const lineItems: Array<{ variant_id: number; quantity: number; price: string }> = [];
    for (const item of items) {
      const productUrl = tiendanubeBaseUrl(
        credentials.storeId, `products/${item.productId}`,
      );
      let product: TiendanubeProduct;
      try {
        product = await tiendanubeRequest<TiendanubeProduct>(
          productUrl, credentials.accessToken,
        );
      } catch {
        return errResponse(
          "PRODUCT_NOT_FOUND",
          `Product ${item.productId} not found on Tiendanube.`,
        );
      }

      const variantId = product.variants[0]?.id;
      if (variantId === undefined) {
        return errResponse(
          "PRODUCT_NOT_FOUND",
          `Product ${item.productId} has no variants on Tiendanube.`,
        );
      }

      // Use caller-supplied price if provided; fall back to TN's current variant price.
      const price = item.unitPrice !== undefined
        ? item.unitPrice.toFixed(2)
        : product.variants[0]!.price;

      lineItems.push({ variant_id: variantId, quantity: item.quantity, price });
    }

    const orderBody: Record<string, unknown> = {
      products: lineItems,
      ...(customerId ? { customer: { id: Number(customerId) } } : {}),
      ...(paymentMethod ? { gateway: paymentMethod } : {}),
    };

    const ordersUrl = tiendanubeBaseUrl(credentials.storeId, "orders");
    const created = await tiendanubeRequest<TiendanubeOrder>(
      ordersUrl, credentials.accessToken, "POST", orderBody,
    );

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          orderId: String(created.id),
          orderNumber: created.number,
          status: created.status,
          total: created.total,
          createdAt: created.created_at,
          backend: "tiendanube",
        }),
      }],
    };
  }

  // ── register_movement ───────────────────────────────────────────────────────
  //
  // NOT SUPPORTED: Tiendanube has no cash-register / ledger concept.
  // This is a Velora-specific operation (cash-book entry) with no TN equivalent.

  async registerMovement(_input: RegisterMovementInput): Promise<CallToolResult> {
    return errResponse(
      "TIENDANUBE_NOT_SUPPORTED",
      "register_movement is a Velora cash-register concept (cash-book ledger entry) " +
        "and is not supported on Tiendanube. " +
        "Tiendanube has no analog for manual cash movements.",
    );
  }

  // ── return_sale ─────────────────────────────────────────────────────────────
  //
  // Mapped to POST /orders/{id}/cancel — TN's closest equivalent to a return.
  // We find the N most recent open orders (count = input.count) and cancel the first one.

  async returnSale(input: ReturnSaleInput): Promise<CallToolResult> {
    const { businessId, count, cutoffHours } = input;
    const credsOrErr = await requireCredentials(businessId);
    if ("isError" in credsOrErr) return credsOrErr;
    const credentials = credsOrErr;

    // Compute the cutoff timestamp — mirrors Velora's handleReturnSale behaviour.
    const cutoffMs = cutoffHours * 60 * 60 * 1000;
    const undoCutoff = new Date(Date.now() - cutoffMs);

    // Fetch recent open orders (fetch a few extra to have headroom after filtering).
    const ordersUrl =
      `${tiendanubeBaseUrl(credentials.storeId, "orders")}` +
      `?per_page=${count + 5}&sort_by=created_at&sort_direction=desc`;

    const orders = await tiendanubeRequest<TiendanubeOrder[]>(
      ordersUrl, credentials.accessToken,
    );

    // Filter to orders within the cutoff window that are not already cancelled/closed.
    // created_at is an ISO 8601 timestamp on TN orders.
    const eligible = orders.filter(
      (o) =>
        o.status !== "cancelled" &&
        o.status !== "closed" &&
        new Date(o.created_at) >= undoCutoff,
    );

    if (eligible.length === 0) {
      // Mirror Velora's NO_RECENT_SALES error shape exactly.
      return errResponse(
        "NO_RECENT_SALES",
        `No sales found in the last ${cutoffHours} hour(s) to return.`,
      );
    }

    const cancelable = eligible[0]!;
    const cancelUrl = tiendanubeBaseUrl(
      credentials.storeId, `orders/${cancelable.id}/cancel`,
    );
    await tiendanubeRequest(cancelUrl, credentials.accessToken, "POST");

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          cancelledOrderId: String(cancelable.id),
          orderNumber: cancelable.number,
          note: "Order cancelled on Tiendanube (closest TN equivalent to return_sale).",
          backend: "tiendanube",
        }),
      }],
    };
  }
}
