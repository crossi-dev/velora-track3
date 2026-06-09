"use client";

import { tLang } from "./DashboardLangContext";

export function buildStockLoadSuccessMessage(itemSummary: string, requestNumber?: string | null) {
  if (requestNumber) {
    return tLang(`Done, I updated the stock:\n${itemSummary}\nI also generated request ${requestNumber}.`, `Listo, actualicé el stock:\n${itemSummary}\nTambién generé la solicitud ${requestNumber}.`);
  }

  return tLang(`Done, I updated the stock:\n${itemSummary}`, `Listo, actualicé el stock:\n${itemSummary}`);
}
