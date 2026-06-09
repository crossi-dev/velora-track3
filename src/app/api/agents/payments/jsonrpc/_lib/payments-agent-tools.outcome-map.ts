// Outcome → error map for create_payment_link. Extracted from payments-agent-tools.ts
// to keep that file ≤ 300 LOC. Maps every non-success outcome of
// registerSaleWithPaymentLinkUseCase to the tool's error response shape.

import type { RegisterSaleWithPaymentLinkResult } from "@/app/api/payment-intents/_lib/register-sale-with-payment-link-use-case";

export interface ToolErrorResponse {
  error: string;
  message?: string;
  currency: "ARS";
}

/**
 * Returns a ToolErrorResponse when the use-case outcome is non-success,
 * else null (caller proceeds with created / replayed flow).
 */
export function mapRegisterSaleOutcomeToError(
  saleResult: RegisterSaleWithPaymentLinkResult,
): ToolErrorResponse | null {
  switch (saleResult.outcome) {
    case "idempotency_missing":
    case "idempotency_conflict":
    case "idempotency_in_flight":
      return { error: `intent_${saleResult.outcome}`, currency: "ARS" };
    case "customer_not_found":
      return {
        error: "customer_not_found",
        message: "No encontré ese cliente. Verificá el customerId.",
        currency: "ARS",
      };
    case "product_not_found":
      return {
        error: "product_not_found",
        message: `No encontré el producto ${saleResult.productId} en el catálogo.`,
        currency: "ARS",
      };
    case "wrong_business":
      return {
        error: "wrong_business",
        message: `El producto ${saleResult.productId} no pertenece a este negocio.`,
        currency: "ARS",
      };
    case "invalid_qty":
      return {
        error: "invalid_qty",
        message: `Cantidad inválida para el producto ${saleResult.productId}.`,
        currency: "ARS",
      };
    case "unit_price_out_of_range":
      return {
        error: "unit_price_out_of_range",
        message: `El precio unitario para el producto ${saleResult.productId} supera 10× el precio de catálogo — revisalo.`,
        currency: "ARS",
      };
    case "insufficient_stock":
      return {
        error: "insufficient_stock",
        message: `Stock insuficiente para "${saleResult.productName}". Disponible: ${saleResult.available}.`,
        currency: "ARS",
      };
    case "business_not_found":
      return {
        error: "business_not_found",
        message: "No se encontró el negocio.",
        currency: "ARS",
      };
    case "invalid_total":
      return {
        error: "invalid_total",
        message: "El total calculado no es válido (cero o NaN). Verificá que todos los productos tengan un precio mayor a cero.",
        currency: "ARS",
      };
    default:
      return null;
  }
}
