import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  ensurePlaceholderBusiness,
  findFullBusinessByUserId,
} from "./business-recovery";

const EMPTY_RESPONSE = {
  needsOnboarding: true,
  business: null,
  products: [],
  customers: [],
  suppliers: [],
  sales: [],
  stockMovements: [],
  cashMovements: [],
  invoices: [],
};

export async function handleGetOnboarding(userId: string) {
  let business = await findFullBusinessByUserId(userId);

  if (!business) {
    await ensurePlaceholderBusiness(userId);
    business = await findFullBusinessByUserId(userId);
    if (!business) {
      // ensurePlaceholderBusiness threw and was caught upstream — return empty
      return NextResponse.json(EMPTY_RESPONSE);
    }
  }

  const businessId = business.id;

  // Parallel fetch: cashMovements and invoices are independent.
  // stockMovements are now fetched inside the business query above so they share the
  // same database snapshot as sales — this prevents read-after-write inconsistencies
  // where a sale appears in the Ventas tab but the corresponding stock movement is
  // missing from the Inventario tab.
  const [cashMovementsRaw, cashTotalAgg, invoicesRaw] = await Promise.all([
    prisma.cashMovement.findMany({
      where: { businessId },
      orderBy: { date: "desc" },
      take: 20,
      select: { id: true, saleId: true, type: true, description: true, amount: true, date: true },
    }),
    prisma.cashMovement.aggregate({
      where: { businessId },
      _sum: { amount: true },
    }),
    prisma.invoice.findMany({
      where: { businessId },
      orderBy: { issuedAt: "desc" },
      take: 20,
      select: { id: true, saleId: true, invoiceNumber: true, issuedAt: true, currency: true, totalAmount: true, payloadJson: true, status: true, documentType: true },
    }),
  ]);

  const stockMovementsRaw = business.stockMovements;

  const invoices = invoicesRaw.map((inv) => ({
    ...inv,
    issuedAt: inv.issuedAt.toISOString(),
    totalAmount: Number(inv.totalAmount),
  }));

  const invoiceCustomerNameBySaleId = new Map(
    invoices
      .map((invoice) => {
        try {
          const payload = JSON.parse(invoice.payloadJson) as {
            customer?: { name?: string | null };
          };
          const customerName = payload.customer?.name?.trim() ?? "";
          return customerName ? [invoice.saleId, customerName] : null;
        } catch {
          return null;
        }
      })
      .filter((entry): entry is [string, string] => Boolean(entry))
  );

  const response = NextResponse.json({
    needsOnboarding: false,
    business: {
      id: business.id,
      name: business.name,
      type: business.type,
      cuit: business.cuit,
      address: business.address,
      email: business.email ?? null,
      phone: business.phone,
      whatsappPhone: business.whatsappPhone,
      openingTime: business.openingTime ?? "09:00",
      closingTime: business.closingTime ?? "20:00",
      ivaCondition: business.ivaCondition,
      puntoVenta: business.puntoVenta,
      iibb: business.iibb,
      activityStart: business.activityStart,
      workerCount: Number(business.workerCount ?? 0),
      openingCash: Number(business.openingCash ?? 0),
      currency: business.currency,
      taxRate: Number(business.taxRate),
      allowNegativeStock: business.allowNegativeStock,
      notifyLowStockWa: business.notifyLowStockWa,
      firstSaleConfirmed: business.firstSaleConfirmed,
      createdAt: business.createdAt,
      postalCode: business.postalCode ?? null,
      courierPreference: business.courierPreference ?? null,
    },
    products: business.products.map((product) => ({
      id: product.id,
      name: product.name || "Producto sin nombre",
      price: Number(product.price ?? 0),
      sku: product.sku || null,
      stock: product.quantity,
    })),
    customers: business.customers.map((c) => ({
      id: c.id,
      name: c.name || "Cliente sin nombre",
      phone: c.phone || null,
      email: c.email || null,
      taxId: c.taxId || null,
      address: c.address || null,
      postalCode: c.postalCode || null,
      city: c.city || null,
    })),
    suppliers: business.suppliers.map((supplier) => ({
      id: supplier.id,
      name: supplier.name || "Proveedor sin nombre",
      phone: supplier.phone || null,
      contactName: supplier.contactName || null,
      taxId: null,
      email: supplier.email || null,
      leadTimeDays: supplier.leadTimeDays,
    })),
    sales: business.sales.map((sale) => ({
      id: sale.id,
      date: sale.date,
      totalAmount: Number(sale.totalAmount),
      status: sale.status,
      customer:
        sale.customer ??
        (() => {
          const fallbackName = invoiceCustomerNameBySaleId.get(sale.id);
          return fallbackName ? { id: null, name: fallbackName } : null;
        })(),
      items: sale.saleItems.map((item) => ({
        quantity: item.quantity,
        unitPrice: Number(item.unitPrice),
        unitCost: item.unitCost != null ? Number(item.unitCost) : null,
        product: item.product,
      })),
    })),
    stockMovements: stockMovementsRaw.map((m) => ({
      id: m.id,
      productId: m.productId,
      productName: m.productName,
      quantityBefore: m.quantityBefore,
      quantityAfter: m.quantityAfter,
      delta: m.delta,
      reason: m.reason,
      referenceId: m.referenceId,
      createdAt: m.createdAt.toISOString(),
    })),
    cashMovements: cashMovementsRaw.map((movement) => ({
      id: movement.id,
      saleId: movement.saleId ?? null,
      type: movement.type,
      description: movement.description,
      amount: Number(movement.amount),
      date: movement.date,
    })),
    cashTotal: Number(cashTotalAgg._sum.amount ?? 0),
    invoices: invoices.map((invoice) => {
      let payload: unknown = null;
      try {
        payload = JSON.parse(invoice.payloadJson);
      } catch {
        payload = null;
      }
      return {
        id: invoice.id,
        saleId: invoice.saleId,
        invoiceNumber: invoice.invoiceNumber,
        issuedAt: invoice.issuedAt,
        currency: invoice.currency,
        totalAmount: Number(invoice.totalAmount),
        status: invoice.status,
        documentType: invoice.documentType,
        payload,
      };
    }),
  });
  response.headers.set("Cache-Control", "private, max-age=15, stale-while-revalidate=30");
  return response;
}
