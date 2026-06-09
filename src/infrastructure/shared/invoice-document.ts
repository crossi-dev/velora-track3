import type { Prisma } from "@prisma/client";
import { normalizeCustomerName } from "@/lib/normalize";

export type InvoicePayload = {
  /**
   * Document type hint forwarded to the PDF renderer.
   * "invoice" — fiscal Factura header with letter box + CAE block (AFIP RG 2485 / RG 4291).
   * "receipt" (default) — "COMPROBANTE / sin validez fiscal" header, no CAE block.
   *
   * Standalone PaymentIntent PDFs always use "receipt" — the fiscal Factura C is
   * emitted separately by the Fiscal Agent (WSFE) when ARCA_REAL_MODE=true.
   * Per AFIP 2026 + Stripe canonical pattern, a post-payment receipt is informational;
   * the WSFE-authorised Factura is the legally-binding fiscal document.
   */
  documentType?: "invoice" | "receipt";
  business: {
    name: string;
    cuit: string | null;
    address: string | null;
    currency: string;
    ivaCondition?: string | null;
    puntoVenta?: string | null;
    iibb?: string | null;
    activityStart?: string | null;
    taxRate?: number | null;
  };
  customer: {
    name: string;
    firstName?: string | null;
    lastName?: string | null;
    taxId: string | null;
    email: string | null;
    phone: string | null;
    // Shipping + identity data. Optional so legacy invoices without these
    // fields keep typechecking. sale-post-commit reads these to decide whether
    // to trigger Andreani directly.
    dni?: string | null;
    address?: string | null;
    postalCode?: string | null;
  };
  sale: {
    id: string;
    invoiceNumber: string;
    date: string;
    items: Array<{
      productName: string;
      quantity: number;
      unitPrice: number;
      subtotal: number;
    }>;
    total: number;
    /**
     * Optional shipping line rendered as a separate item row in the PDF.
     * Populated post-pago (from MP preference quote or PaymentIntent.shippingCostARS)
     * so the comprobante reflects the actual freight charge the customer paid.
     * When present it is appended AFTER product items by the PDF renderer.
     */
    shippingLine?: {
      courier: string;
      costARS: number;
    } | null;
  };
};

type InvoiceDocumentClient = {
  invoice: Pick<Prisma.TransactionClient["invoice"], "findMany" | "update" | "updateMany">;
};

export function splitCustomerName(value: string) {
  const normalized = normalizeCustomerName(value);
  if (!normalized) return { firstName: "", lastName: "" };

  const [firstName = "", ...rest] = normalized.split(/\s+/).filter(Boolean);
  return {
    firstName,
    lastName: rest.join(" "),
  };
}

export function buildInvoiceCustomerSnapshot(customer: {
  name: string;
  phone?: string | null;
  email?: string | null;
  taxId?: string | null;
}) {
  const customerName = normalizeCustomerName(customer.name);
  const customerNameParts = splitCustomerName(customerName || customer.name);

  return {
    name: customerName || customer.name,
    firstName: customerNameParts.firstName || null,
    lastName: customerNameParts.lastName || null,
    phone: customer.phone ?? null,
    email: customer.email ?? null,
    taxId: customer.taxId ?? null,
  };
}

export function buildInvoicePayload(args: {
  business: InvoicePayload["business"];
  customer: InvoicePayload["customer"];
  sale: InvoicePayload["sale"];
}): InvoicePayload {
  return {
    business: args.business,
    customer: args.customer,
    sale: args.sale,
  };
}

export async function rewriteCustomerInvoiceSnapshotsInTransaction(
  tx: Prisma.TransactionClient & InvoiceDocumentClient,
  args: {
    businessId: string;
    customerId: string;
    customer: {
      name: string;
      phone: string | null;
      email: string | null;
      taxId: string | null;
    };
  }
) {
  const unsentInvoices = await tx.invoice.findMany({
    where: {
      businessId: args.businessId,
      customerId: args.customerId,
      status: { notIn: ["sent", "paid"] },
    },
    select: {
      id: true,
      payloadJson: true,
    },
  });

  const customerSnapshot = buildInvoiceCustomerSnapshot(args.customer);

  for (const invoice of unsentInvoices) {
    try {
      const payload = JSON.parse(invoice.payloadJson) as InvoicePayload;
      const nextPayload: InvoicePayload = {
        ...payload,
        customer: {
          ...(payload.customer ?? {}),
          ...customerSnapshot,
        },
      };

      // Defense-in-depth tenant guard: scope write by both id+businessId to
      // prevent cross-tenant payload mutation if invoice.id leaked through
      // the findMany above (TOCTOU protection).
      await tx.invoice.updateMany({
        where: { id: invoice.id, businessId: args.businessId },
        data: { payloadJson: JSON.stringify(nextPayload) },
      });
    } catch {
      // Si el payload ya estaba corrupto, no bloqueamos el borrado.
    }
  }

  await tx.invoice.updateMany({
    where: { businessId: args.businessId, customerId: args.customerId },
    data: { customerId: null },
  });
}

/**
 * Rewrite business fiscal data in unsent invoice payloads when business profile is updated.
 * Only affects invoices with status "issued" — sent/paid invoices preserve historical data.
 */
export async function rewriteBusinessInvoiceSnapshotsInTransaction(
  tx: Prisma.TransactionClient & InvoiceDocumentClient,
  args: {
    businessId: string;
    business: {
      name: string;
      cuit: string | null;
      address: string | null;
      currency: string;
      ivaCondition?: string | null;
      puntoVenta?: string | null;
      iibb?: string | null;
      activityStart?: string | null;
      taxRate?: number | null;
    };
  }
) {
  const unsentInvoices = await tx.invoice.findMany({
    where: {
      businessId: args.businessId,
      status: { notIn: ["sent", "paid"] },
    },
    select: { id: true, payloadJson: true },
  });

  for (const invoice of unsentInvoices) {
    try {
      const payload = JSON.parse(invoice.payloadJson) as InvoicePayload;
      const nextPayload: InvoicePayload = {
        ...payload,
        business: {
          ...payload.business,
          name: args.business.name,
          cuit: args.business.cuit,
          address: args.business.address,
          currency: args.business.currency,
          ivaCondition: args.business.ivaCondition ?? null,
          puntoVenta: args.business.puntoVenta ?? null,
          iibb: args.business.iibb ?? null,
          activityStart: args.business.activityStart ?? null,
          taxRate: args.business.taxRate ?? null,
        },
      };
      // Defense-in-depth tenant guard: scope write by both id+businessId to
      // prevent cross-tenant payload mutation if invoice.id leaked through
      // the findMany above (TOCTOU protection).
      await tx.invoice.updateMany({
        where: { id: invoice.id, businessId: args.businessId },
        data: { payloadJson: JSON.stringify(nextPayload) },
      });
    } catch {
      // Corrupted payload — don't block the business update
    }
  }
}
