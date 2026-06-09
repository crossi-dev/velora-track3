import { STORAGE_KEY } from "./storage-keys";

const APP_SETTINGS_KEY = STORAGE_KEY.APP_SETTINGS;

export interface AppSettings {
  theme: "light" | "dark" | "auto";
  showAssistantSuggestions: boolean;
  voiceEnabled: boolean;
  alwaysOpenMain: boolean;
  showLowStockAlerts: boolean;
  defaultCustomer: string;
  allowSaleWithoutCustomer: boolean;
  openReceiptAfterSale: boolean;
  lowStockThreshold: number;
  allowNegativeStock: boolean;
  autoCreateProductOnStockLoad: boolean;
  suggestWhatsappAfterSale: boolean;
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  theme: "auto",
  showAssistantSuggestions: true,
  voiceEnabled: true,
  alwaysOpenMain: true,
  showLowStockAlerts: true,
  defaultCustomer: "Consumidor Final",
  allowSaleWithoutCustomer: true,
  openReceiptAfterSale: false,
  lowStockThreshold: 5,
  allowNegativeStock: false,
  autoCreateProductOnStockLoad: true,
  suggestWhatsappAfterSale: true,
};

export function getAppSettings(): AppSettings {
  if (typeof window === "undefined") return { ...DEFAULT_APP_SETTINGS };
  try {
    const raw = localStorage.getItem(APP_SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_APP_SETTINGS };
    return { ...DEFAULT_APP_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_APP_SETTINGS };
  }
}

export function saveAppSettings(settings: AppSettings) {
  try {
    localStorage.setItem(APP_SETTINGS_KEY, JSON.stringify(settings));
  } catch (err) {
    // Quota exceeded — settings stay in-memory only.
    console.warn("[appSettings] localStorage save failed:", err);
  }
}

/**
 * Apply theme and text-size preferences to document.documentElement.
 * Safe to call on every render — reads from localStorage.
 */
export function applyAppSettingsToDOM() {
  if (typeof document === "undefined") return;
  const settings = getAppSettings();

  // Theme
  const root = document.documentElement;
  if (settings.theme === "dark") {
    root.setAttribute("data-theme", "dark");
  } else if (settings.theme === "light") {
    root.setAttribute("data-theme", "light");
  } else {
    root.removeAttribute("data-theme");
  }

}
