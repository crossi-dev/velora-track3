"use client";

import { tLang } from "./DashboardLangContext";

export function buildPurchaseRequestDownloadMessage(requestNumber: string) {
  return tLang(`Downloading request ${requestNumber}.`, `Descargando solicitud ${requestNumber}.`);
}
