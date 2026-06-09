// Executor for sale_create_inline_new_customer — fires when the fast-path
// detector parsed "a/para [Name] [phone]" in a sale turn and no existing
// catalog customer matched that name or phone.
//
// Strategy:
//   - Build confirmation card (same UX as sale_create).
//   - Embed `register_sale_with_new_customer` action so the client-side
//     confirm handler can (1) upsert the customer by phone, then (2) register
//     the sale with the new customerId — both in a single server round-trip.
//
// Idempotency: the confirm handler on the server side must use upsert-by-phone
// when creating the customer so retries with the same clientMessageId do NOT
// produce a duplicate customer. The sale itself uses the standard idempotency
// key (clientMessageId, actionType, businessId) enforced in the mutation contract.
//
// PII handling: newCustomerPhone (E.164) is sent in the confirmationRequest
// action blob. It is a user-provided phone visible to the owner — not
// considered PII requiring redaction at this layer. The CriticalWriteEvent
// recorder redacts phone fields per the standard PII policy when the sale
// mutation fires.

import { NextResponse } from "next/server";
import { cloudLog } from "@/lib/cloud-logger";
import { buildConfirmationRequest } from "../confirmation";
import { buildLocalSaleDraft } from "./build-local-sale-draft";
import type { SaleCreateInlineNewCustomerIntent } from "./types";
import type { PreModelIntentParams } from "../router-params";

export function executeSaleCreateInlineCustomer(
  intent: SaleCreateInlineNewCustomerIntent,
  params: PreModelIntentParams,
): NextResponse {
  const startedAt = Date.now();

  // Money-path guard: product must exist in catalog. Defense-in-depth —
  // detector already resolved it, but future callers may bypass.
  const productInCatalog = params.productInfoDirectory.find(
    (p) => p.id === intent.matchedProductId,
  ) ?? null;
  if (!productInCatalog) {
    cloudLog({
      severity: "WARNING",
      component: "SaleExecutor",
      action: "REJECTED_HALLUCINATED_ID",
      a2a_transfer: false,
      message: "sale_create_inline_new_customer: matchedProductId not in catalog",
      businessId: params.businessId,
      actorEmployeeId: params.actorEmployeeId ?? undefined,
      data: { matchedProductId: intent.matchedProductId },
    });
    const clarification = `No encontré "${intent.productName}" en el catálogo. ¿Cuál es el producto exacto?`;
    return NextResponse.json({ answer: clarification });
  }

  // Build a provisional sale draft so the client modal shows totals.
  // Customer fields are null until the server creates the customer on confirm.
  const saleDraft = buildLocalSaleDraft({
    matchedProductId: intent.matchedProductId,
    matchedCustomerId: null,
    productInfo: params.productInfoDirectory,
    customers: params.context.catalog.customers,
  });

  if (saleDraft && intent.qty > 1) {
    const item = saleDraft.items[0];
    if (item) {
      item.quantity = intent.qty;
      item.subtotal = item.unitPrice * intent.qty;
      saleDraft.total = item.subtotal;
    }
  }
  if (saleDraft && intent.unitPrice !== null) {
    const item = saleDraft.items[0];
    if (item) {
      item.unitPrice = intent.unitPrice;
      item.subtotal = intent.unitPrice * item.quantity;
      saleDraft.total = item.subtotal;
    }
  }

  cloudLog({
    severity: "INFO",
    component: "System",
    action: "PRE_MODEL_SALE_CREATE_INLINE_CUSTOMER_HIT",
    a2a_transfer: false,
    message: "dispatcher: sale_create_inline_new_customer fast path executed",
    businessId: params.businessId,
    actorEmployeeId: params.actorEmployeeId ?? undefined,
    data: {
      textLen: params.text.length,
      productName: intent.productName,
      newCustomerName: intent.newCustomerName,
      qty: intent.qty,
      unitPriceProvided: intent.unitPrice !== null,
      totalMs: Date.now() - startedAt,
    },
  });

  const unitPriceForDisplay = saleDraft?.items[0]?.unitPrice ?? null;
  const { message, request } = buildInlineCustomerConfirmCard(intent, unitPriceForDisplay);

  return NextResponse.json({
    answer: message,
    confirmationRequest: request,
    ...(saleDraft ? { saleDraft } : {}),
  });
}

function buildInlineCustomerConfirmCard(
  intent: SaleCreateInlineNewCustomerIntent,
  unitPriceForDisplay: number | null,
) {
  const qtyLabel = intent.qty > 1 ? `${intent.qty} x ` : "";
  const priceLabel = unitPriceForDisplay !== null
    ? ` — $${unitPriceForDisplay.toLocaleString("es-AR")} c/u`
    : "";
  const totalLabel =
    unitPriceForDisplay !== null && intent.qty > 1
      ? ` (total $${(unitPriceForDisplay * intent.qty).toLocaleString("es-AR")})`
      : "";
  const message =
    `¿Confirmás la venta? ${qtyLabel}${intent.productName}${priceLabel}${totalLabel} ` +
    `a ${intent.newCustomerName} (${intent.newCustomerPhone}) — cliente nuevo.`;

  // Embed sale items so the client confirm handler can call sale.create
  // directly (no second /api/parse-sale round-trip).
  const unitPrice = unitPriceForDisplay ?? 0;
  const qty = intent.qty ?? 1;
  const saleItems = [{ productId: intent.matchedProductId, quantity: qty, unitPrice }];
  const saleTotal = unitPrice * qty;

  const request = buildConfirmationRequest({
    severity: "warning",
    title: "Confirmar venta + cliente nuevo",
    message,
    action: {
      type: "register_sale_with_new_customer",
      matchedProductId: intent.matchedProductId,
      autoSend: false,
      newCustomer: {
        name: intent.newCustomerName,
        phone: intent.newCustomerPhone,
      },
      saleItems,
      saleTotal,
    },
  });
  return { message, request };
}
