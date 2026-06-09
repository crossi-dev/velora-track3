"use client";

import type { ContactRow, InvoiceRecord } from "./types";

function normalizePhoneDigits(value: string | null | undefined) {
  return (value ?? "").replace(/\D/g, "");
}

export function getInvoicesForClient(row: ContactRow, invoices: InvoiceRecord[]) {
  return invoices.filter((invoice) => {
    if (!invoice.payload) return false;

    const invoiceCustomer = invoice.payload.customer;
    const clientPhone = normalizePhoneDigits(row.phone);
    const invoicePhone = normalizePhoneDigits(invoiceCustomer.phone);

    if (clientPhone && invoicePhone) {
      return clientPhone === invoicePhone;
    }

    return invoiceCustomer.name === row.name;
  });
}

export function sumInvoiceTotals(invoices: Array<Pick<InvoiceRecord, "totalAmount">>) {
  return invoices.reduce((sum, invoice) => sum + Number(invoice.totalAmount ?? 0), 0);
}
