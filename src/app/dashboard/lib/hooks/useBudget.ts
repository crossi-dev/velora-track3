"use client";

import { useState } from "react";
import { executeDashboardAction } from "../actions/executeDashboardAction";

interface LineItem {
  productId: string;
  name: string;
  quantity: number;
  unitPrice: number;
}

export function useBudget(t: (en: string, es: string) => string) {
  const [notice, setNotice] = useState<string | null>(null);

  async function sendByWhatsApp(opts: {
    filledItems: LineItem[];
    customerName: string;
    phone: string;
  }) {
    const { filledItems, customerName, phone } = opts;

    if (filledItems.length === 0) {
      setNotice(t("Add at least one product.", "Agregá al menos un producto."));
      return false;
    }
    if (!phone.trim()) {
      setNotice(t("A phone number is required to send via WhatsApp.", "Necesitás un teléfono para enviar por WhatsApp."));
      return false;
    }

    try {
      const createResult = await executeDashboardAction("budget.create", {
        customerName: customerName.trim() || null,
        items: filledItems.map((it) => ({
          productId: it.productId || null,
          name: it.name,
          quantity: it.quantity,
          unitPrice: it.unitPrice,
        })),
      });
      const budgetId = createResult?.budget?.id;
      if (budgetId) {
        const sendResult = await executeDashboardAction("budget.send-whatsapp", {
          budgetId,
          phone: phone.trim(),
        });
        if (!sendResult?.ok) {
          setNotice(t("Could not send via WhatsApp. Check the number includes the country code (e.g. +54911...).", "No se pudo enviar por WhatsApp. Verificá el número con prefijo de país (ej: +54911...)."));
          return false;
        }

        setNotice(t("Quote sent via WhatsApp.", "Presupuesto enviado por WhatsApp."));
        return true;
      } else {
        setNotice(t("Could not create the quote.", "No se pudo crear el presupuesto."));
        return false;
      }
    } catch {
      setNotice(t("Error creating the quote.", "Error al crear presupuesto."));
      return false;
    }
  }

  return { notice, setNotice, sendByWhatsApp };
}
