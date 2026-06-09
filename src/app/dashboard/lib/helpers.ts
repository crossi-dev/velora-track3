import { tLang } from "./DashboardLangContext";
import type { SiteLocale } from "@/lib/site-locale";
import type { CashMovement } from "./types";

export {
  normalizeLookupText,
  normalizePersonOrBusinessName,
  splitCustomerName,
  buildCustomerFullName,
  translateBusinessType,
} from "@/lib/shared-utils";

export function toFiniteNumber(value: unknown) {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

export function moneyFmt(value: unknown, currency: string, locale: SiteLocale) {
  return `${currency || "ARS"} ${toFiniteNumber(value).toLocaleString(locale === "es-419" ? "es-AR" : "en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatNumber(value: unknown, locale: SiteLocale) {
  return toFiniteNumber(value).toLocaleString(locale === "es-419" ? "es-AR" : "en-US");
}

export function formatDate(value: string, locale: SiteLocale) {
  return new Date(value).toLocaleDateString(locale === "es-419" ? "es-AR" : "en-CA", {
    timeZone: "America/Argentina/Buenos_Aires",
  });
}

export function formatTime(value: string, locale: SiteLocale) {
  return new Date(value).toLocaleTimeString(locale === "es-419" ? "es-AR" : "en-US", {
    timeZone: "America/Argentina/Buenos_Aires",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function movementTypeLabel(value: string, t: (en: string, es: string) => string) {
  return (
    ({
      sale: t("Sale", "Venta"),
      income: t("Income", "Ingreso"),
      purchase: t("Compra", "Compra"),
      tax: t("Pago de impuestos", "Pago de impuestos"),
      salary: t("Pago de salarios", "Pago de salarios"),
      adjustment: t("Ajuste de caja", "Ajuste de caja"),
    })[value] ?? value
  );
}

const ARGENTINA_TZ_LABEL = "America/Argentina/Buenos_Aires";
const ARGENTINA_DATE_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: ARGENTINA_TZ_LABEL,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function getArgentinaDateStr(ms: number): string {
  return ARGENTINA_DATE_FMT.format(new Date(ms));
}

export function formatDateLabel(timestamp: string | number): string {
  const ms = typeof timestamp === "string" ? new Date(timestamp).getTime() : timestamp;
  const todayStr = getArgentinaDateStr(Date.now());
  const msgStr = getArgentinaDateStr(ms);

  const [ty, tm, td] = todayStr.split("-").map(Number);
  const [my, mm, md] = msgStr.split("-").map(Number);
  const todayMs = Date.UTC(ty, tm - 1, td);
  const msgMs = Date.UTC(my, mm - 1, md);
  const diffDays = Math.round((todayMs - msgMs) / 86400000);

  if (diffDays === 0) return tLang("Today", "Hoy");
  if (diffDays === 1) return tLang("Yesterday", "Ayer");
  return `${String(md).padStart(2, "0")}/${String(mm).padStart(2, "0")}/${my}`;
}

export function movementDescriptionLabel(movement: CashMovement, locale: SiteLocale, t: (en: string, es: string) => string) {
  const raw = movement.description?.trim() ?? "";
  if (!raw) return movementTypeLabel(movement.type, t);
  if (locale !== "es-419") return raw;

  if (movement.type === "sale") {
    const englishSaleMatch = raw.match(/^sale\s+to\s+(.+)$/i);
    if (englishSaleMatch?.[1]) return t(`Sale to ${englishSaleMatch[1]}`, `Venta a ${englishSaleMatch[1]}`);
    if (/^recorded sale$/i.test(raw)) return t("Recorded sale", "Venta registrada");
  }

  return raw;
}
