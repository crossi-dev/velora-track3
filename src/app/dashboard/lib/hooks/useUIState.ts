"use client";

import { useState } from "react";
import type { TabKey } from "../types";

const SIDEBAR_STORAGE_KEY = "velora:sidebarState";

function readSidebarStorage(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return localStorage.getItem(SIDEBAR_STORAGE_KEY) === "expanded";
  } catch {
    return false;
  }
}

function writeSidebarStorage(open: boolean): void {
  try {
    localStorage.setItem(SIDEBAR_STORAGE_KEY, open ? "expanded" : "collapsed");
  } catch {
    // localStorage disabled — silent fail
  }
}

export function useUIState() {
  const [sidebarOpen, setSidebarOpenRaw] = useState<boolean>(() => readSidebarStorage());

  const setSidebarOpen: typeof setSidebarOpenRaw = (updater) => {
    setSidebarOpenRaw((current) => {
      const next = typeof updater === "function" ? updater(current) : updater;
      writeSidebarStorage(next);
      return next;
    });
  };
  const [savedProductId, setSavedProductId] = useState<string | null>(null);
  const [savedClientId, setSavedClientId] = useState<string | null>(null);
  const [savedSupplierId, setSavedSupplierId] = useState<string | null>(null);
  const [downloadingInvoiceId, setDownloadingInvoiceId] = useState<string | null>(null);
  const [downloadingPurchaseRequestId, setDownloadingPurchaseRequestId] = useState<string | null>(null);

  // Helper for flashing saved status
  function flashSaved(setter: (id: string | null) => void, id: string, duration = 2000) {
    setter(id);
    setTimeout(() => setter(null), duration);
  }

  const tabLabels: Record<TabKey, { en: string; es: string }> = {
    main: { en: "Home", es: "Principal" },
    sales: { en: "Sales", es: "Ventas" },
    inventory: { en: "Inventory", es: "Inventario" },
    clients: { en: "Clients", es: "Clientes" },
    suppliers: { en: "Suppliers", es: "Proveedores" },
    budget: { en: "Budget", es: "Presupuesto" },
    invoices: { en: "Invoices", es: "Facturas" },
    team: { en: "Team", es: "Equipo" },
    servicios: { en: "Services", es: "Servicios" },
    settings: { en: "Settings", es: "Ajustes" },
    conversations: { en: "Conversations", es: "Conversaciones" },
  };

  const sectionMeta: Record<Exclude<TabKey, "main">, { eyebrow: { en: string; es: string }; title: { en: string; es: string }; description: { en: string; es: string } }> = {
    sales: {
      eyebrow: { en: "", es: "" },
      title: { en: "Sales & Cash", es: "Ventas y Caja" },
      description: { en: "", es: "" }
    },
    inventory: { eyebrow: { en: "", es: "" }, title: { en: "Inventory", es: "Inventario" }, description: { en: "", es: "" } },
    clients: { eyebrow: { en: "", es: "" }, title: { en: "Clients", es: "Clientes" }, description: { en: "", es: "" } },
    suppliers: { eyebrow: { en: "", es: "" }, title: { en: "Suppliers", es: "Proveedores" }, description: { en: "", es: "" } },
    budget: { eyebrow: { en: "", es: "" }, title: { en: "Budget", es: "Presupuesto" }, description: { en: "", es: "" } },
    invoices: { eyebrow: { en: "", es: "" }, title: { en: "Invoices", es: "Facturas" }, description: { en: "", es: "" } },
    team: { eyebrow: { en: "", es: "" }, title: { en: "Team", es: "Equipo" }, description: { en: "", es: "" } },
    servicios: { eyebrow: { en: "", es: "" }, title: { en: "Services", es: "Servicios" }, description: { en: "", es: "" } },
    settings: {
      eyebrow: { en: "Settings", es: "Ajustes" },
      title: { en: "Business profile", es: "Perfil del negocio" },
      description: {
        en: "Review the main business data saved during settings and keep base information accessible.",
        es: "Revisá los datos principales de la empresa guardados durante los ajustes y mantené accesible la información base."
      }
    },
    conversations: {
      eyebrow: { en: "WhatsApp", es: "WhatsApp" },
      title: { en: "Customer conversations", es: "Conversaciones con clientes" },
      description: { en: "", es: "" }
    },
  };

  const dashboardQuickActions = [
    { key: "sale", titleEN: "New sale", titleES: "Nueva venta", exampleEN: '"record a sale to Final Consumer for 2 filters"', exampleES: '"registrá una venta a Consumidor Final por 2 filtros"' },
    { key: "clients", titleEN: "New customer", titleES: "Nuevo cliente", exampleEN: '"add a new customer: Juan Pérez"', exampleES: '"agregá un nuevo cliente: Juan Pérez"' },
    { key: "product", titleEN: "New product", titleES: "Nuevo producto", exampleEN: '"create a product: Air Filter, price 12000, quantity 10"', exampleES: '"creá un producto: Filtro de aire, precio 12000, cantidad 10"' },
    { key: "invoices", titleEN: "Search invoice", titleES: "Buscar factura", exampleEN: '"find invoice 0001-00001234"', exampleES: '"buscá la factura 0001-00001234"' },
    { key: "inventory", titleEN: "View low inventory", titleES: "Ver inventario bajo", exampleEN: '"show me the low inventory"', exampleES: '"mostrame el inventario bajo"' },
  ];

  return {
    sidebarOpen, setSidebarOpen,
    savedProductId, setSavedProductId,
    savedClientId, setSavedClientId,
    savedSupplierId, setSavedSupplierId,
    downloadingInvoiceId, setDownloadingInvoiceId,
    downloadingPurchaseRequestId, setDownloadingPurchaseRequestId,
    flashSaved,
    tabLabels,
    sectionMeta,
    dashboardQuickActions
  };
}
