// Executor for the sale_create Fast Path. Companion to executeSaleSend —
// difference is `autoSend: false` (no WhatsApp dispatch after register).
//
// Builds a local saleDraft so the client doesn't need to roundtrip
// /api/parse-sale (Vertex-dependent, currently flaky). Pure function over
// the already-detected intent + dispatcher params. No RBAC gate — both
// owner and employee can register sales.

import { NextResponse } from "next/server";
import { cloudLog } from "@/lib/cloud-logger";
import { buildLocalSaleDraft } from "./build-local-sale-draft";
import { buildConfirmationRequest } from "../confirmation";
import type { SaleCreateIntent } from "./types";
import type { PreModelIntentParams } from "../router-params";

export function executeSaleCreate(
  intent: SaleCreateIntent,
  params: PreModelIntentParams,
): NextResponse {
  const startedAt = Date.now();

  // Preflight: if the business has no_sale_without_customer active and the
  // draft has no customer, ask before opening the confirm modal. The server
  // would 403 post-confirm — surfacing it here avoids the bad UX.
  const noSaleWithoutCustomerRule = params.context.activeRules?.find(
    (r) => r.trigger === "no_sale_without_customer",
  ) ?? null;
  if (noSaleWithoutCustomerRule && !intent.matchedCustomerId) {
    const msg = noSaleWithoutCustomerRule.message?.trim()
      ? `¿A qué cliente? ${noSaleWithoutCustomerRule.message}`
      : "¿A qué cliente hacemos la venta? El negocio requiere registrar el cliente en cada venta.";
    return NextResponse.json({ answer: msg });
  }

  // Money-path guard: reject null or hallucinated product IDs before any
  // action reaches the client. Defense-in-depth — the sale_create fast-path
  // detector (sale-create-fast-path.ts) already guarantees a non-null,
  // catalog-resolved ID, but we re-check here in case future callers bypass
  // that guarantee or the type widens.
  const productInCatalog = intent.matchedProductId
    ? params.productInfoDirectory.find((p) => p.id === intent.matchedProductId) ?? null
    : null;

  if (!intent.matchedProductId || !productInCatalog) {
    cloudLog({
      severity: "WARNING",
      component: "SaleExecutor",
      action: "REJECTED_HALLUCINATED_ID",
      a2a_transfer: false,
      message: "sale_create: matchedProductId not in catalog",
      businessId: params.businessId,
      actorEmployeeId: params.actorEmployeeId ?? undefined,
      data: {
        matchedProductId: intent.matchedProductId ?? null,
        matchedCustomerId: intent.matchedCustomerId ?? null,
      },
    });
    const clarification = intent.productName
      ? `No encontré "${intent.productName}" en el catálogo. ¿Cuál es el producto exacto que querés vender?`
      : "No pude identificar el producto. ¿Cuál es el producto que querés vender?";
    return NextResponse.json({ answer: clarification });
  }

  const saleDraft = buildLocalSaleDraft({
    matchedProductId: intent.matchedProductId,
    matchedCustomerId: intent.matchedCustomerId,
    productInfo: params.productInfoDirectory,
    customers: params.context.catalog.customers,
  });

  // If we have a multi-qty draft, scale items locally so the client modal
  // shows the right total before confirm. buildLocalSaleDraft hardcodes
  // qty=1; we patch that here when intent.qty > 1.
  if (saleDraft && intent.qty > 1) {
    const item = saleDraft.items[0];
    if (item) {
      item.quantity = intent.qty;
      item.subtotal = item.unitPrice * intent.qty;
      saleDraft.total = item.subtotal;
    }
  }

  // If the user gave an explicit unit price, override the catalog price.
  // The detector now propagates unitPrice for qty>1 when the syntax is
  // unambiguous ("a X", "a $X", "cada una X") — honor it here regardless of qty.
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
    action: "PRE_MODEL_SALE_CREATE_HIT",
    a2a_transfer: false,
    message: "dispatcher: sale_create fast path executed",
    businessId: params.businessId,
    actorEmployeeId: params.actorEmployeeId ?? undefined,
    data: {
      textLen: params.text.length,
      productName: intent.productName,
      customerName: intent.customerName,
      qty: intent.qty,
      unitPriceProvided: intent.unitPrice !== null,
      saleDraftBuilt: saleDraft !== null,
      totalMs: Date.now() - startedAt,
    },
  });

  const unitPriceForDisplay = saleDraft?.items[0]?.unitPrice ?? null;
  const confirmationCard = buildSaleConfirmationCard(
    intent,
    unitPriceForDisplay,
  );

  return NextResponse.json({
    answer: confirmationCard.message,
    confirmationRequest: confirmationCard.request,
    ...(saleDraft ? { saleDraft } : {}),
  });
}

function buildSaleConfirmationCard(
  intent: SaleCreateIntent,
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
  const customerPart = intent.customerName ? ` a ${intent.customerName}` : "";
  const message = `¿Confirmás la venta? ${qtyLabel}${intent.productName}${priceLabel}${totalLabel}${customerPart}.`;
  const request = buildConfirmationRequest({
    severity: "warning",
    title: "Confirmar venta",
    message,
    action: {
      type: "register_sale",
      matchedProductId: intent.matchedProductId,
      matchedCustomerId: intent.matchedCustomerId,
      autoSend: false,
    },
  });
  return { message, request };
}
