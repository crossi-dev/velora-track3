// src/lib/mcp/_lib/velora-cobro-detail.ts — getCobroDetail implementation.
//
// Extracted from velora-payments.adapter.ts to stay under the 300-line file-size limit.
// Contains the full logic for resolving a single PaymentIntent by id or customer name
// and mapping it to CobroDetail.
//
// Tenant isolation: businessId ALWAYS comes from the tenantId input field.
// READ-ONLY — no mutations. Reuses the same join pattern as listPendingOrders.
//
// Resolution order:
//   1. paymentIntentId supplied → ownership check (businessId + id) → full fetch
//   2. customerName supplied → fuzzy resolveCustomerIdByName → most-recent PI → full fetch
//   Returns null when not found at any step.

import type { GetCobroDetailInput, CobroDetail, PendingOrderItem, CobroEstado } from "./payments-backend.port";
import { resolveCustomerIdByName } from "@/app/api/agents/payments/jsonrpc/_lib/payments-agent-helpers";
import { prisma } from "@/lib/prisma";

const VALID_ESTADOS = ["pending", "confirmed", "expired", "cancelled"] as const;

function guardEstado(raw: string): CobroEstado {
  return (VALID_ESTADOS as ReadonlyArray<string>).includes(raw)
    ? (raw as CobroEstado)
    : "pending";
}

/**
 * Returns the detail of a single cobro (PaymentIntent), or null when not found.
 * Resolves by paymentIntentId or most-recent PI for customerName (same fuzzy
 * resolution as getPaymentStatus). READ-ONLY — no mutations.
 */
export async function getCobroDetailImpl(input: GetCobroDetailInput): Promise<CobroDetail | null> {
  const { tenantId: businessId, paymentIntentId, customerName } = input;

  // At least one lookup key required — callers must guard before calling.
  if (!paymentIntentId && !customerName) return null;

  let resolvedIntentId = paymentIntentId ?? null;

  // Ownership pre-check by id — same ownership pattern as getPaymentStatus.
  if (resolvedIntentId) {
    const owned = await prisma.paymentIntent.findFirst({
      where: { id: resolvedIntentId, businessId },
      select: { id: true },
    });
    if (!owned) return null;
  }

  // Fuzzy customer resolution — mirrors getPaymentStatus exactly.
  if (!resolvedIntentId && customerName) {
    const customerId = await resolveCustomerIdByName(businessId, customerName);
    if (!customerId) return null;
    const intent = await prisma.paymentIntent.findFirst({
      where: { businessId, matchedCustomerId: customerId },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    if (!intent) return null;
    resolvedIntentId = intent.id;
  }

  // Full detail fetch — reuses the same join pattern as listPendingOrders.
  const pi = await prisma.paymentIntent.findFirst({
    where: { id: resolvedIntentId!, businessId },
    select: {
      id: true,
      monto: true,
      estado: true,
      checkoutUrl: true,
      createdAt: true,
      confirmedAt: true,
      items: true,
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

  if (!pi) return null;

  const customerNameResolved =
    pi.sale?.customer?.name ?? pi.matchedCustomer?.name ?? "Desconocido";

  // Items: prefer Sale.saleItems when linked, fall back to PI.items JSON blob.
  let items: PendingOrderItem[] = [];
  if (pi.sale?.saleItems && pi.sale.saleItems.length > 0) {
    items = pi.sale.saleItems.map((si) => ({
      productId: si.productId ?? null,
      name: si.product?.name ?? "Producto",
      quantity: si.quantity,
      unitPrice: Number(si.unitPrice),
    }));
  } else if (pi.items !== null && Array.isArray(pi.items)) {
    items = (pi.items as Array<{ productName?: string; quantity?: number; unitPrice?: number }>).map(
      (it) => ({
        productId: null,
        name: it.productName ?? "Producto",
        quantity: it.quantity ?? 1,
        unitPrice: it.unitPrice ?? 0,
      }),
    );
  }

  return {
    id: pi.id,
    estado: guardEstado(pi.estado),
    customerName: customerNameResolved,
    items,
    totalARS: Number(pi.monto),
    createdAt: pi.createdAt,
    confirmedAt: pi.confirmedAt ?? null,
    checkoutUrl: pi.checkoutUrl ?? null,
  };
}
