import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { BusinessRepositoryPort, BusinessForUpdate, BusinessUpdateData } from "@/domain/ports/business.repository.port";
import type { Tx } from "@/domain/ports/tx";
import { rewriteBusinessInvoiceSnapshotsInTransaction } from "@/infrastructure/shared/invoice-document";
import { cloudLog } from "@/lib/cloud-logger";
import { toPrismaTx } from "@/infrastructure/persistence/tx-client";

const BUSINESS_SELECT = {
  id: true, name: true, type: true, email: true, cuit: true, address: true,
  phone: true, whatsappPhone: true, alias: true, openingTime: true, closingTime: true,
  currency: true, taxRate: true, ivaCondition: true, puntoVenta: true,
  iibb: true, activityStart: true, allowNegativeStock: true, defaultCustomer: true,
  allowSaleWithoutCustomer: true, openReceiptAfterSale: true,
  autoCreateProductOnStockLoad: true, suggestWhatsappAfterSale: true,
  lowStockThreshold: true, postalCode: true, courierPreference: true,
  notifyLowStockWa: true,
  // Step 1.5c: E.164 phone for lightweight pre-Embedded-Signup WA capture.
  whatsappBusinessPhoneE164: true,
} as const;

function toBusinessForUpdate(row: Prisma.BusinessGetPayload<{ select: typeof BUSINESS_SELECT }>): BusinessForUpdate {
  return {
    id: row.id, name: row.name, type: row.type, email: row.email,
    cuit: row.cuit, address: row.address, phone: row.phone,
    whatsappPhone: row.whatsappPhone, alias: row.alias,
    openingTime: row.openingTime,
    closingTime: row.closingTime, currency: row.currency,
    taxRate: Number(row.taxRate), ivaCondition: row.ivaCondition,
    puntoVenta: row.puntoVenta, iibb: row.iibb,
    activityStart: row.activityStart, allowNegativeStock: row.allowNegativeStock ?? false,
    defaultCustomer: row.defaultCustomer, allowSaleWithoutCustomer: row.allowSaleWithoutCustomer,
    openReceiptAfterSale: row.openReceiptAfterSale,
    autoCreateProductOnStockLoad: row.autoCreateProductOnStockLoad,
    suggestWhatsappAfterSale: row.suggestWhatsappAfterSale,
    lowStockThreshold: row.lowStockThreshold,
    postalCode: row.postalCode ?? null,
    courierPreference: row.courierPreference ?? null,
    notifyLowStockWa: row.notifyLowStockWa,
    whatsappBusinessPhoneE164: row.whatsappBusinessPhoneE164 ?? null,
  };
}

export const prismaBusinessRepository: BusinessRepositoryPort = {
  async findById(id: string) {
    const row = await prisma.business.findUnique({
      where: { id },
      select: { id: true, allowNegativeStock: true },
    });
    if (!row) return null;
    return { id: row.id, allowNegativeStock: row.allowNegativeStock ?? false };
  },

  async findCurrency(id: string) {
    return prisma.business.findUnique({ where: { id }, select: { currency: true } });
  },

  async findByUserId(userId: string) {
    return prisma.business.findUnique({ where: { userId }, select: { id: true } });
  },

  async findForUpdate(businessId: string): Promise<BusinessForUpdate | null> {
    const row = await prisma.business.findUnique({
      where: { id: businessId },
      select: BUSINESS_SELECT,
    });
    return row ? toBusinessForUpdate(row) : null;
  },

  async updateInTransaction(tx: Tx, businessId: string, data: BusinessUpdateData): Promise<BusinessForUpdate> {
    const prismaTx = toPrismaTx(tx);
    const updated = await prismaTx.business.update({
      where: { id: businessId },
      data: {
        name: data.name, type: data.type, email: data.email, cuit: data.cuit,
        address: data.address, phone: data.phone, whatsappPhone: data.whatsappPhone,
        alias: data.alias,
        openingTime: data.openingTime, closingTime: data.closingTime,
        currency: data.currency, taxRate: data.taxRate,
        ivaCondition: data.ivaCondition, puntoVenta: data.puntoVenta,
        iibb: data.iibb, activityStart: data.activityStart,
        allowNegativeStock: data.allowNegativeStock,
        defaultCustomer: data.defaultCustomer,
        allowSaleWithoutCustomer: data.allowSaleWithoutCustomer,
        openReceiptAfterSale: data.openReceiptAfterSale,
        autoCreateProductOnStockLoad: data.autoCreateProductOnStockLoad,
        suggestWhatsappAfterSale: data.suggestWhatsappAfterSale,
        lowStockThreshold: data.lowStockThreshold,
        postalCode: data.postalCode,
        courierPreference: data.courierPreference,
        notifyLowStockWa: data.notifyLowStockWa,
        whatsappBusinessPhoneE164: data.whatsappBusinessPhoneE164,
      },
      select: BUSINESS_SELECT,
    });
    try {
      await rewriteBusinessInvoiceSnapshotsInTransaction(prismaTx as never, {
        businessId,
        business: {
          name: updated.name, cuit: updated.cuit, address: updated.address,
          currency: updated.currency, ivaCondition: updated.ivaCondition,
          puntoVenta: updated.puntoVenta, iibb: updated.iibb,
          activityStart: updated.activityStart ?? null,
          taxRate: Number(updated.taxRate),
        },
      });
    } catch (err) {
      // Invoice rewrite is best-effort — don't block business update.
      // But surface the failure: stale invoice snapshots can cause
      // downstream fiscal/email artifacts to show outdated tax rates,
      // CUIT, or punto de venta. We log so on-call can audit affected
      // invoices and trigger a backfill.
      cloudLog({
        severity: "WARNING",
        component: "System",
        action: "INVOICE_SNAPSHOT_REWRITE_FAILED",
        a2a_transfer: false,
        message: "Invoice snapshot rewrite failed after business update — snapshots may be stale",
        businessId,
        data: { error: err instanceof Error ? err.message : String(err) },
      });
    }
    return toBusinessForUpdate(updated);
  },
};
