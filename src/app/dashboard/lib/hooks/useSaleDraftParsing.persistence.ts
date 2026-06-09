"use client";

import { useEffect, useRef } from "react";
import {
  GENERIC_SALE_DRAFT_KEY,
  GENERIC_PENDING_SALE_FLOW_KEY,
  readPersistedJson,
} from "./sale-draft-utils";
import type { ParsedSale } from "../types";

/**
 * Hook-shaped helper that handles localStorage hydration & persistence for the
 * sale draft. Hydrates once per business-scoped key, mirrors `parsed` state to
 * localStorage, and clears any stale pendingSaleFlow on mount.
 */
export function useSaleDraftPersistence(params: {
  saleDraftKey: string;
  pendingSaleFlowKey: string;
  businessId: string | null;
  parsed: ParsedSale | null;
  setParsedRaw: (value: ParsedSale | null) => void;
}) {
  const { saleDraftKey, pendingSaleFlowKey, businessId, parsed, setParsedRaw } = params;
  const hydratedSaleDraftKeyRef = useRef<string | null>(null);

  // Hydrate from scoped key, falling back to legacy generic key once.
  useEffect(() => {
    if (hydratedSaleDraftKeyRef.current === saleDraftKey) return;
    hydratedSaleDraftKeyRef.current = saleDraftKey;

    const hydratedScopedDraft = readPersistedJson<ParsedSale>(saleDraftKey);
    if (hydratedScopedDraft) {
      setParsedRaw(hydratedScopedDraft);
      return;
    }
    if (businessId) {
      const fallbackDraft = readPersistedJson<ParsedSale>(GENERIC_SALE_DRAFT_KEY);
      if (!fallbackDraft) return;
      setParsedRaw(fallbackDraft);
      try {
        localStorage.setItem(saleDraftKey, JSON.stringify(fallbackDraft));
      } catch (err) {
        console.error("[sale-draft] No se pudo migrar el borrador al key con scope de negocio (cuota de localStorage excedida).", err);
      }
    }
  }, [saleDraftKey, businessId, setParsedRaw]);

  // Mirror `parsed` to localStorage.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (parsed === null) {
      localStorage.removeItem(saleDraftKey);
      return;
    }
    try {
      localStorage.setItem(saleDraftKey, JSON.stringify(parsed));
    } catch (err) {
      console.error("[sale-draft] No se pudo guardar el borrador de venta en localStorage (cuota excedida). El borrador de recuperación ante cierre no estará disponible.", err);
    }
  }, [saleDraftKey, parsed]);

  // Clean up any stale pendingSaleFlow from localStorage on mount.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      localStorage.removeItem(pendingSaleFlowKey);
      localStorage.removeItem(GENERIC_PENDING_SALE_FLOW_KEY);
    } catch { /* safe */ }
  }, [pendingSaleFlowKey]);
}
