// src/lib/mcp/_lib/velora-pending-orders.ts — listPendingOrders implementation.
//
// Extracted from velora-payments.adapter.ts to stay under the 300-line file-size limit.
// Contains the full logic for fetching pending PaymentIntents and mapping them to
// PendingOrder display shapes.
//
// Tenant isolation: businessId ALWAYS comes from the tenantId input field.
// READ-ONLY — no mutations. At most 20 results ordered newest first.
//
// Customer name resolution order:
//   1. sale.customer.name (linked Sale row)
//   2. matchedCustomer.name (PI.matchedCustomerId denorm)
//   3. "Desconocido"
//
// Items resolution order:
//   1. Sale.saleItems when a linked sale exists
//   2. PaymentIntent.items JSON blob (standalone PI)
//   3. empty array

import type { ListPendingOrdersInput, PendingOrder, PendingOrderItem } from "./payments-backend.port";
import { prisma } from "@/lib/prisma";

/**
 * Returns at most 20 pending PaymentIntents for the tenant, ordered newest first.
 * Tenant isolation: businessId always from input.tenantId.
 */
export async function listPendingOrdersImpl(
  input: ListPendingOrdersInput,
): Promise<PendingOrder[]> {
  const businessId = input.tenantId; // tenant isolation: always from closure via port input

  const intents = await prisma.paymentIntent.findMany({
    where: { businessId, estado: "pending" },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: {
      id: true,
      monto: true,
      checkoutUrl: true,
      createdAt: true,
      items: true,
      shippingCostARS: true,
      matchedCustomer: { select: { name: true } },
      sale: {
        select: {
          customer: { select: { name: true } },
          saleItems: {
            select: {
              productId: true,
              quantity: true,
              unitPrice: true,
              product: { select: { name: true } },
            },
          },
        },
      },
    },
  });

  return intents.map((pi): PendingOrder => {
    // Resolve customer name: prefer sale.customer, fall back to matchedCustomer, then "Desconocido".
    const customerName =
      pi.sale?.customer?.name ?? pi.matchedCustomer?.name ?? "Desconocido";

    // Build items from Sale.saleItems when a linked sale exists.
    // Fall back to PaymentIntent.items (JSON blob for standalone PIs).
    let items: PendingOrderItem[] = [];

    if (pi.sale?.saleItems && pi.sale.saleItems.length > 0) {
      items = pi.sale.saleItems.map((si) => ({
        productId: si.productId ?? null,
        name: si.product?.name ?? "Producto",
        quantity: si.quantity,
        unitPrice: Number(si.unitPrice),
      }));
    } else if (pi.items !== null && Array.isArray(pi.items)) {
      // Standalone PI items: Array<{ productName, quantity, unitPrice, subtotal }>
      items = (pi.items as Array<{ productName?: string; quantity?: number; unitPrice?: number }>).map(
        (it) => ({
          productId: null,
          name: it.productName ?? "Producto",
          quantity: it.quantity ?? 1,
          unitPrice: it.unitPrice ?? 0,
        }),
      );
    }

    // monto (totalARS) is itemsSubtotal + shippingCostARS (see
    // register-sale-with-payment-link-use-case.ts). Without a shipping line the
    // widget total would exceed the sum of displayed items whenever shipping
    // applies — append it so the two always reconcile.
    const shippingCostARS = pi.shippingCostARS ? Number(pi.shippingCostARS) : 0;
    if (shippingCostARS > 0) {
      items = [...items, { productId: null, name: "Envío", quantity: 1, unitPrice: shippingCostARS }];
    }

    const totalARS = Number(pi.monto);

    return {
      id: pi.id,
      customerName,
      items,
      totalARS,
      status: "pending",
      createdAt: pi.createdAt,
      checkoutUrl: pi.checkoutUrl ?? null,
    };
  });
}
