"use client";

import { tLang } from "./DashboardLangContext";

export function buildInvoiceDownloadMessage(invoiceNumber: string) {
  return tLang(`Downloading invoice ${invoiceNumber}.`, `Descargando factura ${invoiceNumber}.`);
}
