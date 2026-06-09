"use client";

import type { Dispatch, SetStateAction } from "react";
import { executeDashboardAction } from "./actions/executeDashboardAction";
import { fetchWithTimeout } from "./hooks/utils";
import type { SettingsForm } from "./types";

/**
 * POST a file to /api/import, refresh the business dataset, and return the
 * server-reported counts. Errors bubble up as Error instances with the server
 * message (or a default) attached.
 */
export async function performImport(
  type: "products" | "customers" | "suppliers",
  file: File,
  deps: {
    loadBusiness: (opts?: { silent?: boolean; force?: boolean }) => Promise<unknown>;
    markUpdated: (kind: "products" | "customers" | "suppliers") => void;
  }
): Promise<{ imported: number; skipped?: number }> {
  const form = new FormData();
  form.append("file", file);
  form.append("type", type);

  const res = await fetchWithTimeout("/api/import", { method: "POST", body: form });
  const data = (await res.json().catch(() => null)) as
    | { imported?: number; skipped?: number; error?: string }
    | null;

  if (!res.ok) {
    throw new Error(data?.error ?? "Error al importar");
  }

  await deps.loadBusiness({ silent: true, force: true }).catch(() => {});
  deps.markUpdated(type);

  return {
    imported: Number(data?.imported ?? 0),
    skipped: Number(data?.skipped ?? 0) || undefined,
  };
}

/**
 * Save the full business settings form. On success: refresh + notice. On
 * failure: surface the error both in the settings panel and in the chat log.
 */
export async function handleSaveSettings(
  e: React.FormEvent,
  deps: {
    settingsForm: SettingsForm | null;
    setLoadingSettings: Dispatch<SetStateAction<boolean>>;
    setSettingsError: Dispatch<SetStateAction<string | null>>;
    setSettingsNotice: Dispatch<SetStateAction<string | null>>;
    loadBusiness: (opts?: { silent?: boolean; force?: boolean }) => Promise<unknown>;
    appendChatHistoryEntry: (kind: "error", text: string) => void;
  }
) {
  e.preventDefault();
  if (!deps.settingsForm) return;

  deps.setLoadingSettings(true);
  deps.setSettingsError(null);
  deps.setSettingsNotice(null);

  try {
    await executeDashboardAction("business.update", {
      name: deps.settingsForm.name,
      type: deps.settingsForm.type,
      address: deps.settingsForm.address,
      phone: deps.settingsForm.phone,
      whatsappPhone: deps.settingsForm.whatsappPhone,
      alias: deps.settingsForm.alias.trim() ? deps.settingsForm.alias.trim() : null,
      currency: deps.settingsForm.currency,
      defaultCustomer: deps.settingsForm.defaultCustomer,
      allowSaleWithoutCustomer: deps.settingsForm.allowSaleWithoutCustomer,
      openReceiptAfterSale: deps.settingsForm.openReceiptAfterSale,
      autoCreateProductOnStockLoad: deps.settingsForm.autoCreateProductOnStockLoad,
      suggestWhatsappAfterSale: deps.settingsForm.suggestWhatsappAfterSale,
      lowStockThreshold: deps.settingsForm.lowStockThreshold,
      allowNegativeStock: deps.settingsForm.allowNegativeStock,
      notifyLowStockWa: deps.settingsForm.notifyLowStockWa,
      cuit: deps.settingsForm.cuit.trim() || null,
      ivaCondition: deps.settingsForm.ivaCondition.trim() || null,
      puntoVenta: deps.settingsForm.puntoVenta.trim() || null,
      postalCode: deps.settingsForm.postalCode.trim() || null,
      courierPreference: (deps.settingsForm.courierPreference as "Andreani" | "OCA" | "ninguno" | "") || null,
    });

    await deps.loadBusiness({ silent: true, force: true }).catch(() => {});
    // If the reload above failed silently, businessData.dataStale will be
    // true and the StaleDataBanner (always rendered) will surface that to
    // the user automatically — no need to degrade the success message here.
    deps.setSettingsNotice("Settings saved.");
  } catch (error) {
    const rawMsg = error instanceof Error ? error.message : "Could not save settings.";
    const ERROR_TRANSLATIONS: Record<string, string> = {
      "Business name is required.": "El nombre del negocio es obligatorio.",
      "Business type is required.": "El tipo de negocio es obligatorio.",
      "Could not save settings.": "No se pudieron guardar los ajustes.",
    };
    const errMsg = ERROR_TRANSLATIONS[rawMsg] ?? rawMsg;
    deps.setSettingsError(errMsg);
    deps.appendChatHistoryEntry("error", errMsg);
  } finally {
    deps.setLoadingSettings(false);
  }
}
