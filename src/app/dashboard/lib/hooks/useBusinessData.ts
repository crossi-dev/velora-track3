"use client";

import { useState, useMemo, useEffect, useRef, startTransition } from "react";
import { fetchWithTimeout, normalizePersonOrBusinessName, getSafeJson } from "./utils";
import { useDashboardLang } from "../DashboardLangContext";
import type {
  Business,
  Product,
  ContactRow,
  SaleRecord,
  CashMovement,
  StockMovement,
  InvoiceRecord,
  DashboardNotification,
  SettingsForm
} from "../types";

interface useBusinessDataOptions {
  locale: string;
  setPageError: (msg: string | null) => void;
  setLoadingPage: (loading: boolean) => void;
  setSuccessNotice: (msg: string | null) => void;
  appendChatHistoryEntry: (kind: "user" | "reply" | "success" | "error", text: string) => void;
  t: (en: string, es: string) => string;
}

export function useBusinessData(opts: useBusinessDataOptions) {
  const { t } = useDashboardLang();
  const [businessId, setBusinessId] = useState<string | null>(null);
  const [business, setBusiness] = useState<Business | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [clients, setClients] = useState<ContactRow[]>([]);
  const [manufacturers, setManufacturers] = useState<ContactRow[]>([]);
  const [sales, setSales] = useState<SaleRecord[]>([]);
  const [cashMovements, setCashMovements] = useState<CashMovement[]>([]);
  const [cashTotal, setCashTotal] = useState<number>(0);
  const [stockMovements, setStockMovements] = useState<StockMovement[]>([]);
  const [invoices, setInvoices] = useState<InvoiceRecord[]>([]);
  
  const [lastUpdated, setLastUpdated] = useState<Record<string, number>>({});
  const [eventNotifications, setEventNotifications] = useState<DashboardNotification[]>([]);
  const [derivedNotifications, setDerivedNotifications] = useState<DashboardNotification[]>([]);
  
  const [dataStale, setDataStale] = useState(false);

  const [employeeName, setEmployeeName] = useState<string>("");

  const [settingsForm, setSettingsForm] = useState<SettingsForm | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [settingsNotice, setSettingsNotice] = useState<string | null>(null);
  const [loadingSettings, setLoadingSettings] = useState(false);

  const { locale, setPageError, setLoadingPage } = opts;

  // Deduplication: skip overlapping loadBusiness calls, but remember if a
  // refresh was requested while one was already in-flight.
  const loadInFlightRef = useRef(false);
  const refreshNeededRef = useRef(false);
  const lastSuccessfulLoadRef = useRef<number>(0);

  function markUpdated(key: string) {
    setLastUpdated((prev) => ({ ...prev, [key]: Date.now() }));
  }

  function markUpdatedMany(keys: string[]) {
    const now = Date.now();
    setLastUpdated((prev) => {
      const next = { ...prev };
      for (const k of keys) next[k] = now;
      return next;
    });
  }

  const notifications = useMemo(
    () => [...eventNotifications, ...derivedNotifications],
    [eventNotifications, derivedNotifications]
  );

  async function loadBusiness({ silent = false, force = false }: { silent?: boolean; force?: boolean } = {}) {
    // Skip silent reloads if data was fetched recently (30s TTL),
    // unless force is set (post-mutation reloads need fresh data).
    if (silent && !force && lastSuccessfulLoadRef.current && Date.now() - lastSuccessfulLoadRef.current < 30_000) {
      return;
    }

    // Deduplicate: if a load is already in-flight, mark that a refresh is
    // needed once the current one finishes and bail out.
    if (loadInFlightRef.current) {
      refreshNeededRef.current = true;
      return;
    }

    loadInFlightRef.current = true;
    refreshNeededRef.current = false;

    if (!silent) setLoadingPage(true);
    setPageError(null);

    try {
      // skipAuthRedirect=true: this call intentionally checks for 401 to detect
      // employee sessions before falling back to the login redirect.
      const res = await fetchWithTimeout("/api/onboarding", {}, 15_000, undefined, true);
      if (res.status === 401) {
        // Could be an employee session — try the employee context endpoint before
        // redirecting. Employees don't have NextAuth sessions so /api/onboarding
        // always returns 401 for them.
        const empRes = await fetchWithTimeout("/api/employee/context", {}, 15_000, undefined, true);
        if (empRes.ok) {
          const empData = await getSafeJson<{
            employee?: { name?: string };
            business: Business;
            products?: { id: string; name: string; price: number; sku: string | null; stock: number; costPrice: null }[];
            customers?: { id: string; name: string; phone: string | null }[];
            cashMovements?: CashMovement[];
            cashTotal?: number;
            sales?: SaleRecord[];
          }>(
            empRes,
            t("Could not load the business.", "No se pudo cargar el negocio."),
          );
          if (empData?.business?.id) {
            setEmployeeName(empData.employee?.name ?? "");
            setBusinessId(empData.business.id);
            setBusiness(empData.business);
            setProducts(Array.isArray(empData.products) ? empData.products : []);
            setClients(
              (Array.isArray(empData.customers) ? empData.customers : []).map((c) => ({
                ...c,
                name: normalizePersonOrBusinessName(c.name ?? ""),
                email: null,
                taxId: null,
              }))
            );
            setManufacturers([]);
            setSales(Array.isArray(empData.sales) ? empData.sales : []);
            setCashMovements(Array.isArray(empData.cashMovements) ? empData.cashMovements : []);
            setCashTotal(typeof empData.cashTotal === "number" ? empData.cashTotal : 0);
            setStockMovements([]);
            setInvoices([]);
            markUpdatedMany(["products", "clients", "suppliers", "sales", "cash"]);
            setDataStale(false);
            lastSuccessfulLoadRef.current = Date.now();
          }
          return;
        }
        window.location.replace("/");
        return;
      }
      if (res.status === 404) {
        // No business yet — leave business=null so DashboardPage renders the
        // inline OnboardingChat. Don't redirect: the dashboard owns the
        // first-run conversation now.
        setBusiness(null);
        return;
      }
      const data = await getSafeJson<{
        business?: (Business & {
          allowNegativeStock?: boolean;
          defaultCustomer?: string;
          allowSaleWithoutCustomer?: boolean;
          openReceiptAfterSale?: boolean;
          autoCreateProductOnStockLoad?: boolean;
          suggestWhatsappAfterSale?: boolean;
          lowStockThreshold?: number;
          notifyLowStockWa?: boolean;
        }) | null;
        products?: Product[];
        customers?: ContactRow[];
        suppliers?: ContactRow[];
        sales?: SaleRecord[];
        cashMovements?: CashMovement[];
        cashTotal?: number;
        stockMovements?: StockMovement[];
        invoices?: InvoiceRecord[];
      }>(res, t("Could not load the business. Please try again.", "No se pudo cargar el negocio. Por favor, intentá de nuevo."));
      if (!data?.business?.id) {
        // Same as 404 above — DashboardPage handles no-business inline.
        setBusiness(null);
        return;
      }

      // ── CRITICAL: set business identity and unblock the chat tab ──────────
      // The chat path only needs `business` to function — products/clients/sales
      // are optional display hints (all accessed via `?.`). Clear loadingPage
      // here so React can commit the chat render before non-critical data arrives.
      setBusinessId(data.business.id);
      setBusiness(data.business);
      if (!silent) setLoadingPage(false);

      // ── NON-CRITICAL: populate tab data via low-priority transition ──────
      // startTransition tells React 19 these updates are non-urgent: the
      // critical render (chat tab) commits first, then these populate in the
      // background without blocking the UI.
      // Source: https://react.dev/reference/react/startTransition
      const nonCriticalData = data;
      startTransition(() => {
        setProducts(nonCriticalData.products ?? []);
        setClients(
          (nonCriticalData.customers ?? []).map((customer: ContactRow) => ({
            ...customer,
            name: normalizePersonOrBusinessName(customer.name ?? ""),
          }))
        );
        setManufacturers(nonCriticalData.suppliers ?? []);
        setSales(nonCriticalData.sales ?? []);
        setCashMovements(nonCriticalData.cashMovements ?? []);
        setCashTotal(typeof nonCriticalData.cashTotal === "number" ? nonCriticalData.cashTotal : 0);
        setStockMovements(nonCriticalData.stockMovements ?? []);
        setInvoices(nonCriticalData.invoices ?? []);
        markUpdatedMany(["products", "clients", "suppliers", "sales", "cash"]);
        setDataStale(false);
      });

      lastSuccessfulLoadRef.current = Date.now();

      // Sync business-op settings from DB to localStorage — DB is single source of truth.
      // Dynamic import keeps appSettings.ts out of the initial bundle.
      void import("../appSettings").then(({ getAppSettings, saveAppSettings }) => {
        const settings = getAppSettings();
        const b = nonCriticalData.business!;
        const patch: Partial<typeof settings> = {};
        if (typeof b.allowNegativeStock === "boolean" && settings.allowNegativeStock !== b.allowNegativeStock) patch.allowNegativeStock = b.allowNegativeStock;
        if (typeof b.defaultCustomer === "string" && settings.defaultCustomer !== b.defaultCustomer) patch.defaultCustomer = b.defaultCustomer;
        if (typeof b.allowSaleWithoutCustomer === "boolean" && settings.allowSaleWithoutCustomer !== b.allowSaleWithoutCustomer) patch.allowSaleWithoutCustomer = b.allowSaleWithoutCustomer;
        if (typeof b.openReceiptAfterSale === "boolean" && settings.openReceiptAfterSale !== b.openReceiptAfterSale) patch.openReceiptAfterSale = b.openReceiptAfterSale;
        if (typeof b.autoCreateProductOnStockLoad === "boolean" && settings.autoCreateProductOnStockLoad !== b.autoCreateProductOnStockLoad) patch.autoCreateProductOnStockLoad = b.autoCreateProductOnStockLoad;
        if (typeof b.suggestWhatsappAfterSale === "boolean" && settings.suggestWhatsappAfterSale !== b.suggestWhatsappAfterSale) patch.suggestWhatsappAfterSale = b.suggestWhatsappAfterSale;
        if (typeof b.lowStockThreshold === "number" && settings.lowStockThreshold !== b.lowStockThreshold) patch.lowStockThreshold = b.lowStockThreshold;
        if (Object.keys(patch).length > 0) saveAppSettings({ ...settings, ...patch });
      });
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : t("Could not load the business.", "No se pudo cargar el negocio.");
      if (silent) {
        // Background reload failed — data is stale but the mutation succeeded.
        // Surface a warning instead of silently swallowing the error.
        setDataStale(true);
        console.error("[loadBusiness silent] reload failed, data may be stale:", errMsg);
        console.warn("[loadBusiness silent] reload failed, data may be stale:", errMsg);
      } else {
        setPageError(errMsg);
      }
      // Only clear data on initial load (no existing data).
      // On background refreshes, preserve stale-but-valid state.
      if (!silent) {
        setProducts([]);
        setClients([]);
        setManufacturers([]);
        setInvoices([]);
        setSales([]);
        setCashMovements([]);
        setStockMovements([]);
      }
    } finally {
      if (!silent) setLoadingPage(false);
      loadInFlightRef.current = false;

      // If another caller requested a refresh while we were loading,
      // run one more silent reload to pick up the latest data.
      if (refreshNeededRef.current) {
        refreshNeededRef.current = false;
        // force: true bypasses the 30s TTL guard — lastSuccessfulLoadRef was
        // just set, so without force this deferred retry would always be skipped.
        void loadBusiness({ silent: true, force: true });
      }
    }
  }

  // Effect for derived notifications (stock, invoices)
  useEffect(() => {
    const now = Date.now();
    const next: DashboardNotification[] = [];

    for (const product of products) {
      const stockNum = Number(product.stock);
      if (stockNum > 5) continue;
      const outOfStock = stockNum <= 0;
      const restockText = encodeURIComponent(`Hola, necesito reponer ${product.name}.`);
      next.push({
        id: `stock-${product.id}`,
        kind: outOfStock ? "critical" : "warning",
        title: t(`${outOfStock ? "Out of stock" : "Low stock"}: ${product.name}`, `Inventario ${outOfStock ? "agotado" : "bajo"}: ${product.name}`),
        body: outOfStock ? t("No units left.", "No quedan unidades.") : t(`${product.stock} units left.`, `Quedan ${product.stock} unidades.`),
        href: `https://wa.me/?text=${restockText}`,
        ctaLabel: "Reponer",
        timestamp: now,
      });
    }

    for (const invoice of invoices) {
      if (invoice.status !== "issued") continue;
      const phone = (invoice.payload?.customer?.phone ?? "").replace(/\D/g, "");
      const invoiceText = encodeURIComponent(`Hola, te envío la factura ${invoice.invoiceNumber}.`);
      next.push({
        id: `invoice-issued-${invoice.id}`,
        kind: "warning",
        title: t("Invoice pending dispatch", "Factura pendiente de envío"),
        body: invoice.invoiceNumber,
        href: phone ? `https://wa.me/${phone}?text=${invoiceText}` : undefined,
        ctaLabel: phone ? "Enviar" : undefined,
        timestamp: now,
      });
    }

    setDerivedNotifications(next);
  }, [locale, products, invoices, t]);

  // Effect to sync settings form when business changes
  useEffect(() => {
    if (!business) return;

    setSettingsForm({
      name: business.name ?? "",
      type: business.type ?? "",
      address: business.address ?? "",
      phone: business.phone ?? "",
      whatsappPhone: business.whatsappPhone ?? "",
      alias: business.alias ?? "",
      currency: business.currency ?? "ARS",
      defaultCustomer: business.defaultCustomer ?? "Consumidor Final",
      allowSaleWithoutCustomer: business.allowSaleWithoutCustomer ?? true,
      openReceiptAfterSale: business.openReceiptAfterSale ?? false,
      autoCreateProductOnStockLoad: business.autoCreateProductOnStockLoad ?? false,
      suggestWhatsappAfterSale: business.suggestWhatsappAfterSale ?? true,
      lowStockThreshold: business.lowStockThreshold ?? 5,
      allowNegativeStock: business.allowNegativeStock ?? false,
      notifyLowStockWa: business.notifyLowStockWa ?? false,
      cuit: business.cuit ?? "",
      ivaCondition: business.ivaCondition ?? "",
      puntoVenta: business.puntoVenta ?? "",
      postalCode: business.postalCode ?? "",
      courierPreference: business.courierPreference ?? "",
    });
    setSettingsError(null);
    setSettingsNotice(null);
  }, [business]);

  return {
    businessId,
    employeeName,
    business, setBusiness,
    products, setProducts,
    clients, setClients,
    manufacturers, setManufacturers,
    sales, setSales,
    cashMovements, setCashMovements, cashTotal,
    stockMovements, setStockMovements,
    invoices, setInvoices,
    lastUpdated, markUpdated, markUpdatedMany,
    notifications, eventNotifications, setEventNotifications,
    settingsForm, setSettingsForm,
    settingsError, setSettingsError,
    settingsNotice, setSettingsNotice,
    loadingSettings, setLoadingSettings,
    dataStale, setDataStale,
    loadBusiness
  };
}
