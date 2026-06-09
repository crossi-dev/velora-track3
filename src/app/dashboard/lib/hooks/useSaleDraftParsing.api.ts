"use client";

import { fetchWithTimeout } from "./utils";
import { tLang } from "../DashboardLangContext";
import {
  defaultPendingSaleInputHint,
  type PendingSaleFlow,
} from "../pendingSaleFlow";
import type { ParsedSale, MissingFieldHint } from "../types";

/**
 * Dependencies the parse-sale API caller needs from the host hook. All state
 * mutators / refs are passed in so this module owns no React state of its own.
 */
export interface CallParseSaleDeps {
  businessId: string | null;
  locale: string;
  pendingSaleFlow: PendingSaleFlow | null;
  setPendingSaleFlow: (value: PendingSaleFlow | null) => void;
  setParseMissingField: (hint: MissingFieldHint | null) => void;
  setParseError: (msg: string | null) => void;
  appendTransientReply: (text: string) => void;
  activatePendingSaleClarification: (flow: PendingSaleFlow) => void;
}

/**
 * Builds the `callParseSale` function bound to a particular set of deps.
 * Returns a function with the same signature as the original closure so the
 * main hook can drop it in unchanged.
 */
export function createCallParseSale(deps: CallParseSaleDeps) {
  const {
    businessId,
    locale,
    pendingSaleFlow,
    setPendingSaleFlow,
    setParseMissingField,
    setParseError,
    appendTransientReply,
    activatePendingSaleClarification,
  } = deps;

  return async function callParseSale(
    text: string,
    hints?: { matchedProductId?: string | null; matchedCustomerId?: string | null },
    priceOverrides?: Record<string, number>
  ): Promise<ParsedSale | null> {
    const resp = await fetchWithTimeout("/api/parse-sale", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        businessId,
        locale,
        matchedProductId: hints?.matchedProductId ?? null,
        matchedCustomerId: hints?.matchedCustomerId ?? null,
        priceOverrides: priceOverrides ?? null,
      }),
    });

    const data = await resp.json().catch(() => null) as
      | { error?: string; missingField?: MissingFieldHint; sales?: ParsedSale[] }
      | ParsedSale
      | null;

    if (!resp.ok) {
      const missingField = data && typeof data === "object" && "missingField" in data
        ? data.missingField
        : null;
      const parseErrorMessage = data && typeof data === "object" && "error" in data && typeof data.error === "string"
        ? data.error
        : tLang("Could not parse the sale.", "No se pudo interpretar la venta.");

      if (missingField?.type === "price" && missingField.productId && missingField.productName) {
        setParseMissingField(missingField);
        setParseError(parseErrorMessage);
        activatePendingSaleClarification({
          saleText: text,
          missingField: "price",
          answer: parseErrorMessage,
          inputHint: defaultPendingSaleInputHint("price"),
          priceProductId: missingField.productId,
          priceProductName: missingField.productName,
        });
        return null;
      }

      throw new Error(parseErrorMessage);
    }

    if (!data || typeof data !== "object") {
      throw new Error(tLang("Could not interpret the sale.", "No se pudo interpretar la venta."));
    }

    setParseMissingField(null);
    if (pendingSaleFlow?.missingField === "price") {
      setPendingSaleFlow(null);
    }
    if ("sales" in data && Array.isArray(data.sales)) {
      if (data.sales.length > 1) {
        appendTransientReply(
          tLang("Registered the first sale. To register the others, say each one separately.", "Registré la primera venta. Para registrar las demás, dictá cada una por separado.")
        );
      }
      return data.sales[0] ?? null;
    }
    return data as ParsedSale;
  };
}

export type CallParseSaleFn = ReturnType<typeof createCallParseSale>;
