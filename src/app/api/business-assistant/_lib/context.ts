import { prisma } from "@/lib/prisma";
import { cloudLog } from "@/lib/cloud-logger";
import type {
  AssistantBusinessPromptContext,
  InvoiceDirectoryEntry,
  LoadedBusinessAssistantContext,
  ProductInfoEntry,
  PurchaseRequestDirectoryEntry,
  PurchaseRequestPayload,
  SupplierDirectoryEntry,
} from "./types";
import { loadStaticBusinessContext, invalidateBusinessContext as _invalidateBusinessContextCache } from "./context-cache";
import { invalidateSupervisorContext } from "@/app/api/supervisor/_lib/load-context";

export function invalidateBusinessContext(businessId: string): void {
  _invalidateBusinessContextCache(businessId);
  invalidateSupervisorContext(businessId);
}

export async function loadBusinessAssistantContext(
  businessId: string
): Promise<LoadedBusinessAssistantContext | null> {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  // Static (cached 90 s): products, customers, suppliers, invoices, top-sellers.
  // Live (always fresh): today's sales total, cash balance.
  const [staticCtx, todaySales, cashBalanceAgg, activeRulesRaw] = await Promise.all([
    loadStaticBusinessContext(businessId),
    prisma.sale.aggregate({
      where: { businessId, date: { gte: startOfToday } },
      _sum: { totalAmount: true },
      _count: { id: true },
    }),
    prisma.cashMovement.aggregate({
      where: { businessId },
      _sum: { amount: true },
    }),
    // Cap at 5 (most recent first) to avoid token bloat and reduce inference latency for demo.
    prisma.businessRule.findMany({
      where: { businessId, active: true },
      select: { kind: true, trigger: true, message: true },
      orderBy: { createdAt: "desc" },
      take: 5,
    }),
  ]);

  if (!staticCtx) return null;

  const { business, invoicesRaw, purchaseRequestsRaw, fullProductCatalog, topProductSales, topProductNameRows } = staticCtx;

  const invoiceCustomerNameBySaleId = new Map(
    invoicesRaw
      .map((invoice) => {
        try {
          const payload = JSON.parse(invoice.payloadJson) as { customer?: { name?: string | null } };
          const customerName = payload.customer?.name?.trim() ?? "";
          return customerName ? [invoice.saleId, customerName] : null;
        } catch (err) {
          cloudLog({ severity: "ERROR", component: "System", action: "CORRUPTED_INVOICE_PAYLOAD", a2a_transfer: false, message: "Corrupted invoice.payloadJson (customer name map)", businessId, data: { rowId: invoice.id, error: err instanceof Error ? err.message : String(err) } });
          return null;
        }
      })
      .filter((entry): entry is [string, string] => Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "string")
  );

  const invoiceDirectory: InvoiceDirectoryEntry[] = invoicesRaw.map((invoice) => {
    let payloadCustomerName = "";
    let payloadCustomerPhone: string | null = null;
    try {
      const payload = JSON.parse(invoice.payloadJson) as { customer?: { name?: string | null; phone?: string | null } };
      payloadCustomerName = payload.customer?.name?.trim() ?? "";
      payloadCustomerPhone = payload.customer?.phone?.trim() ?? null;
    } catch (err) {
      cloudLog({ severity: "ERROR", component: "System", action: "CORRUPTED_INVOICE_PAYLOAD", a2a_transfer: false, message: "Corrupted invoice.payloadJson (directory)", businessId, data: { rowId: invoice.id, error: err instanceof Error ? err.message : String(err) } });
    }
    return {
      id: invoice.id, invoiceNumber: invoice.invoiceNumber,
      status: (invoice.status as "issued" | "sent" | "paid") ?? "issued",
      issuedAt: invoice.issuedAt.toISOString(),
      customerId: invoice.customerId, customerName: payloadCustomerName, customerPhone: payloadCustomerPhone,
    };
  });

  const purchaseRequestDirectory: PurchaseRequestDirectoryEntry[] = purchaseRequestsRaw.map((request) => {
    let payload: PurchaseRequestPayload | null = null;
    let supplierName = "";
    try {
      payload = JSON.parse(request.payloadJson) as PurchaseRequestPayload;
      supplierName = payload.supplier?.name?.trim() ?? "";
    } catch (err) {
      cloudLog({ severity: "ERROR", component: "System", action: "CORRUPTED_PURCHASE_REQUEST_PAYLOAD", a2a_transfer: false, message: "Corrupted purchaseRequest.payloadJson", businessId, data: { rowId: request.id, error: err instanceof Error ? err.message : String(err) } });
    }
    return {
      id: request.id, supplierId: request.supplierId, requestNumber: request.requestNumber,
      issuedAt: request.issuedAt.toISOString(), currency: request.currency,
      totalAmount: Number(request.totalAmount ?? 0), supplierName, payload,
    };
  });

  const supplierDirectory: SupplierDirectoryEntry[] = business.suppliers.map((s) => ({
    name: s.name, phone: s.phone, email: s.email, contactName: s.contactName,
  }));

  const productInfoDirectory: ProductInfoEntry[] = business.products.map((p) => ({
    id: p.id, name: p.name, sku: p.sku, price: Number(p.price), stock: p.quantity,
  }));

  const productIdMap = new Map(fullProductCatalog.map((p) => [p.id, p.name]));
  const topProductNameMap = new Map(topProductNameRows.map((p) => [p.id, p.name]));
  const cashBalance = Number(cashBalanceAgg._sum.amount ?? 0);

  const context: AssistantBusinessPromptContext = {
    business: { name: business.name, type: business.type, currency: business.currency },
    cashBalance,
    inventorySummary: {
      productLines: business.products.length,
      totalUnits: business.products.reduce((sum, p) => sum + p.quantity, 0),
      totalValue: business.products.reduce((sum, p) => sum + Number(p.price) * p.quantity, 0),
    },
    products: business.products.map((p) => ({ name: p.name, price: Number(p.price), stock: p.quantity })),
    suppliers: supplierDirectory,
    recentSales: business.sales.map((sale) => ({
      date: sale.date, totalAmount: Number(sale.totalAmount),
      customer: sale.customer?.name ?? invoiceCustomerNameBySaleId.get(sale.id) ?? null,
      items: sale.saleItems.map((item) => ({ product: item.product?.name ?? "(producto eliminado)", quantity: item.quantity })),
    })),
    catalog: {
      products: fullProductCatalog.map((p) => ({ id: p.id, name: p.name, sku: p.sku })),
      customers: business.customers.map((c) => ({ id: c.id, name: c.name })),
      suppliers: business.suppliers.map((s) => ({ id: s.id, name: s.name })),
    },
    salesStats: {
      today: { count: todaySales._count.id, totalAmount: Number(todaySales._sum.totalAmount ?? 0) },
      topProductsByUnitsSold: topProductSales.map((row) => ({
        productName: row.productId ? (topProductNameMap.get(row.productId) ?? productIdMap.get(row.productId) ?? row.productId) : "(desconocido)",
        unitsSold: row._sum.quantity ?? 0,
      })),
    },
    activeRules: activeRulesRaw.length > 0 ? activeRulesRaw.map((r) => ({ kind: r.kind, trigger: r.trigger, message: r.message })) : undefined,
    currentTime: new Date().toLocaleString("es-AR", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "America/Argentina/Buenos_Aires" }),
  };

  const contextTerms = [
    business.name,
    ...fullProductCatalog.map((p) => p.name),
    ...fullProductCatalog.map((p) => p.sku ?? "").filter((sku): sku is string => Boolean(sku)),
    ...business.customers.map((c) => c.name),
    ...business.suppliers.map((s) => s.name),
    ...invoiceDirectory.map((inv) => inv.invoiceNumber),
    ...purchaseRequestDirectory.map((r) => r.requestNumber),
  ];

  return {
    business, fullCatalogProducts: fullProductCatalog,
    fullCatalogCustomers: business.customers.map((c) => ({ id: c.id, name: c.name })),
    fullCatalogSuppliers: business.suppliers.map((s) => ({ id: s.id, name: s.name })),
    invoiceDirectory, purchaseRequestDirectory, supplierDirectory, productInfoDirectory, context, contextTerms,
  };
}
