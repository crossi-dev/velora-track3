import type { NextRequest, NextResponse } from "next/server";
import { badRequest } from "@/app/api/_lib/route-helpers";
import { parseZodBody } from "@/app/api/_lib/zod-body";
import { normalizeSupplierName } from "@/app/api/_lib/supplier-resolution";
import { normalizeInput, normalizeForMatching } from "../../../../lib/normalize";
import { stockLoadSchema } from "../stock-load-schema";

export type ValidatedStockLoadInput = {
  productId: string;
  itemName: string;
  supplierId: string;
  supplierName: string;
  quantity: number;
  unitPrice: number | null;
  note: string;
  createPurchaseRequest: boolean;
  autoCreateProduct: boolean;
};

// Delegates to canonical normalizeForMatching (NFKC\u2192NFD\u2192\p{M} strip \u2014 wider
// than the old [\u0300-\u036f] range). Dedup 2026-05-29.
export function normalizeLookupText(value: string): string {
  return normalizeForMatching(value.trim());
}

export function parsePositiveInteger(value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.floor(parsed);
}

function parseOptionalNonNegativeNumber(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

export type ValidationResult =
  | { ok: true; data: ValidatedStockLoadInput }
  | { ok: false; response: NextResponse };

export async function parseAndValidateStockLoadRequest(
  req: NextRequest,
): Promise<ValidationResult> {
  const parsed = await parseZodBody(req, stockLoadSchema);
  if (!parsed.ok) return { ok: false, response: parsed.response };

  const productId = normalizeInput(parsed.data.productId);
  const itemName = normalizeInput(parsed.data.itemName);
  const supplierId = normalizeInput(parsed.data.supplierId);
  const supplierName = normalizeSupplierName(parsed.data.supplierName);
  const quantity = parsePositiveInteger(parsed.data.quantity);
  const unitPrice = parseOptionalNonNegativeNumber(parsed.data.unitPrice);
  const note = normalizeInput(parsed.data.note);
  const createPurchaseRequest = Boolean(parsed.data.createPurchaseRequest);
  const autoCreateProduct = parsed.data.autoCreateProduct !== false;

  if (!productId && !itemName) {
    return { ok: false, response: badRequest("Hace falta indicar el producto o el nombre del ítem.") };
  }

  if (quantity === null) {
    return { ok: false, response: badRequest("La cantidad debe ser un número entero mayor a cero.") };
  }

  if (
    parsed.data.unitPrice !== undefined &&
    parsed.data.unitPrice !== null &&
    unitPrice === null
  ) {
    return { ok: false, response: badRequest("El costo unitario debe ser un número mayor o igual a cero.") };
  }

  if (createPurchaseRequest && !supplierId && !supplierName) {
    return {
      ok: false,
      response: badRequest("Hace falta indicar un proveedor para generar la solicitud de compra."),
    };
  }

  if (!productId && !itemName.trim()) {
    return { ok: false, response: badRequest("Hace falta el nombre del ítem.") };
  }

  return {
    ok: true,
    data: {
      productId,
      itemName,
      supplierId,
      supplierName,
      quantity,
      unitPrice,
      note,
      createPurchaseRequest,
      autoCreateProduct,
    },
  };
}
