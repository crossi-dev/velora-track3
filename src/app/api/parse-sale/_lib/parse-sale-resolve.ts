import { prisma } from "@/lib/prisma";
import { cloudLog } from "@/lib/cloud-logger";
import {
  findAmbiguousNameMatch,
  findBestProductMatch,
  isWeakSaleCustomerName,
  normalizePersonOrBusinessName,
  customerClarificationMessage,
} from "./parse-sale-matching";
import { parseUnitPriceString, pickUnitPrice } from "./parse-sale-price";
import { FALLBACK_CUSTOMER_NAME, type RawSaleEntry } from "./parse-sale-types";

type CatalogProduct = {
  id: string;
  name: string;
  price: unknown; // Prisma Decimal — kept as unknown to avoid widening
  sku: string | null;
};

type CatalogCustomer = {
  id: string;
  name: string;
  createdAt: Date;
};

export type ResolvedItem = {
  productId: string;
  productName: string;
  quantity: number;
  unitPrice: number;
  subtotal: number;
};

export type ResolvedSale = {
  customer: { id: string; name: string };
  items: ResolvedItem[];
  total: number;
  skippedProducts?: string[];
};

export type ResolveOutcome =
  | { kind: "ok"; sales: ResolvedSale[] }
  | { kind: "error"; status: number; body: Record<string, unknown> };

export async function resolveSales(params: {
  rawSales: RawSaleEntry[];
  catalogProducts: CatalogProduct[];
  catalogCustomers: CatalogCustomer[];
  matchedProductId: string | null | undefined;
  matchedCustomerId: string | null | undefined;
  priceOverrides: Record<string, number | string> | null | undefined;
}): Promise<ResolveOutcome> {
  const {
    rawSales,
    catalogProducts,
    catalogCustomers,
    matchedProductId,
    matchedCustomerId,
    priceOverrides,
  } = params;

  const resolvedSales: ResolvedSale[] = [];

  for (const rawSale of rawSales) {
    if (!Array.isArray(rawSale.items) || rawSale.items.length === 0) continue;

    const resolvedItems: ResolvedItem[] = [];
    const skippedProducts: string[] = [];
    for (const item of rawSale.items) {
      const matchedProduct =
        matchedProductId && rawSales.length === 1 && rawSale.items.length === 1
          ? catalogProducts.find((product) => product.id === matchedProductId) ?? null
          : findBestProductMatch(item.productName, catalogProducts);

      const product = matchedProduct
        ? {
            id: matchedProduct.id,
            name: matchedProduct.name,
            price: matchedProduct.price,
          }
        : null;

      if (!product) {
        // Skip unrecognized products instead of failing the entire sale
        skippedProducts.push(item.productName);
        continue;
      }

      // Resolve "all" (-1) to current stock quantity
      if (item.quantity === -1) {
        const prod = await prisma.product.findUnique({
          where: { id: product.id },
          select: { quantity: true },
        });
        item.quantity = prod?.quantity ?? 0;
      }

      if (item.quantity <= 0) {
        return {
          kind: "error",
          status: 400,
          body: { error: `No hay stock de "${item.productName}". Cargá stock primero.` },
        };
      }

      const itemUnitPrice = parseUnitPriceString(item.unitPrice);
      // Use toString() for Prisma Decimal safety — Number(Decimal) works but toString is explicit
      const productUnitPrice = Number(String(product.price));
      const overrideUnitPrice = priceOverrides && typeof priceOverrides === "object"
        ? Number(priceOverrides[product.id])
        : Number.NaN;

      const unitPrice = pickUnitPrice({
        parsedUnitPrice: itemUnitPrice,
        productPrice: productUnitPrice,
        override: overrideUnitPrice,
      });

      if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
        cloudLog({ severity: "WARNING", component: "Employee", action: "PARSE_SALE_PRICE_MISSING", a2a_transfer: false, message: `parse-sale: price missing for product "${product.name}"`, data: { productName: product.name, itemUnitPrice: item.unitPrice, productPrice: product.price } });
        return {
          kind: "error",
          status: 400,
          body: {
            error: `Para registrar la venta de "${product.name}" ingresá el precio unitario.`,
            missingField: { type: "price", productId: product.id, productName: product.name },
          },
        };
      }

      resolvedItems.push({
        productId: product.id,
        productName: product.name,
        quantity: item.quantity,
        unitPrice,
        subtotal: item.quantity * unitPrice,
      });
    }

    const parsedCustomerName = rawSale.customerName?.trim();
    const targetCustomerName = normalizePersonOrBusinessName(parsedCustomerName ?? "");

    if (matchedCustomerId && rawSales.length === 1) {
      const matchedCustomer = catalogCustomers.find((customer) => customer.id === matchedCustomerId) ?? null;
      if (!matchedCustomer) {
        return {
          kind: "error",
          status: 400,
          body: { error: customerClarificationMessage("invalid") },
        };
      }

      if (resolvedItems.length === 0) {
        const names = skippedProducts.join(", ");
        return {
          kind: "error",
          status: 400,
          body: { error: `No encontré estos productos: ${names}. Verificá los nombres o crealos primero.` },
        };
      }

      const total = resolvedItems.reduce((sum, i) => sum + i.subtotal, 0);

      resolvedSales.push({
        customer: { id: matchedCustomer.id, name: normalizePersonOrBusinessName(matchedCustomer.name) },
        items: resolvedItems,
        total,
        ...(skippedProducts.length > 0 ? { skippedProducts } : {}),
      });
      continue;
    }

    if (!parsedCustomerName || isWeakSaleCustomerName(targetCustomerName)) {
      if (resolvedItems.length === 0) {
        const names = skippedProducts.join(", ");
        return {
          kind: "error",
          status: 400,
          body: { error: `No encontré estos productos: ${names}. Verificá los nombres o crealos primero.` },
        };
      }

      const total = resolvedItems.reduce((sum, i) => sum + i.subtotal, 0);

      resolvedSales.push({
        customer: { id: "", name: FALLBACK_CUSTOMER_NAME },
        items: resolvedItems,
        total,
        ...(skippedProducts.length > 0 ? { skippedProducts } : {}),
      });
      continue;
    }

    const matchedCustomer = findAmbiguousNameMatch(targetCustomerName, catalogCustomers);

    if (matchedCustomer.ambiguous) {
      return {
        kind: "error",
        status: 400,
        body: { error: customerClarificationMessage("ambiguous") },
      };
    }

    const customer = matchedCustomer.match
      ? { id: matchedCustomer.match.id, name: matchedCustomer.match.name }
      : { id: "", name: targetCustomerName || FALLBACK_CUSTOMER_NAME };

    if (resolvedItems.length === 0) {
      const names = skippedProducts.join(", ");
      return {
        kind: "error",
        status: 400,
        body: { error: `No encontré estos productos: ${names}. Verificá los nombres o crealos primero.` },
      };
    }

    const total = resolvedItems.reduce((sum, i) => sum + i.subtotal, 0);

    resolvedSales.push({
      customer: { ...customer, name: normalizePersonOrBusinessName(customer.name) },
      items: resolvedItems,
      total,
      ...(skippedProducts.length > 0 ? { skippedProducts } : {}),
    });
  }

  return { kind: "ok", sales: resolvedSales };
}
