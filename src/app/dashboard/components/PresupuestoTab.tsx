"use client";

import { useRef, useState, useEffect } from "react";
import { TrashIcon, WhatsappLogoIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { useBudget } from "../lib/hooks/useBudget";
import { SectionMarker } from "./v2/SectionMarker";
import { CustomerCard, ItemsCard, emptyItem, emptyRows, type LineItem } from "./PresupuestoTabItems";

interface PresupuestoTabProps {
  business: { name: string; currency: string };
  products: Array<{ id: string; name: string; price: number; stock: number }>;
  clients: Array<{ id: string; name: string; phone: string }>;
  moneyFmt: (value: unknown, currency: string) => string;
  t: (en: string, es: string) => string;
}

export function PresupuestoTab({ business, products, clients, moneyFmt, t }: PresupuestoTabProps) {
  const [items, setItems] = useState<LineItem[]>(emptyRows(3));
  const [customerId, setCustomerId] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [phone, setPhone] = useState("");
  const [sending, setSending] = useState(false);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const confirmClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => { return () => { if (confirmClearTimerRef.current) clearTimeout(confirmClearTimerRef.current); }; }, []);
  const { notice, setNotice, sendByWhatsApp } = useBudget(t);

  const fmtMoney = (value: number) => moneyFmt(value, business.currency || "ARS");
  const filledItems = items.filter((it) => it.productId && it.quantity > 0);
  const total = filledItems.reduce((sum, it) => sum + it.quantity * it.unitPrice, 0);

  function updateItem(index: number, patch: Partial<LineItem>) {
    setItems((prev) => prev.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  }

  function handleProductSelect(index: number, productId: string) {
    const product = products.find((p) => p.id === productId);
    if (product) {
      updateItem(index, { productId, name: product.name, unitPrice: product.price });
    } else {
      updateItem(index, { productId: "", name: "", unitPrice: 0 });
    }
  }

  function handleCustomerChange(id: string, name: string, selectedPhone: string) {
    setCustomerId(id);
    setCustomerName(name);
    if (selectedPhone) setPhone(selectedPhone);
  }

  function clearAll() {
    setItems(emptyRows(3));
    setCustomerId("");
    setCustomerName("");
    setPhone("");
    setNotice(null);
    setConfirmingClear(false);
    if (confirmClearTimerRef.current) clearTimeout(confirmClearTimerRef.current);
  }

  function handleClearRequest() {
    if (!confirmingClear) {
      setConfirmingClear(true);
      confirmClearTimerRef.current = setTimeout(() => setConfirmingClear(false), 5000);
    } else {
      clearAll();
    }
  }

  async function handleSendByWhatsApp() {
    if (sending) return;
    setSending(true);
    try {
      const ok = await sendByWhatsApp({ filledItems, customerName, phone });
      if (ok) clearAll();
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex flex-col gap-4" style={{ fontFamily: "var(--font-dm-sans)" }}>
      <div className="flex flex-col gap-1.5">
        <SectionMarker label={t("Operations", "Operación")} number="08" />
        <h1 className="t-display-3" style={{ color: "var(--tone-strong)", margin: 0 }}>
          {t("Quotes", "Presupuestos")}
        </h1>
        <p style={{ margin: "4px 0 0", fontSize: "var(--caption)", color: "var(--tone-muted)" }}>
          {t("Build and send quotes via WhatsApp.", "Armá y enviá presupuestos por WhatsApp.")}
        </p>
      </div>

      <CustomerCard
        customerId={customerId}
        phone={phone}
        clients={clients}
        onCustomerChange={handleCustomerChange}
        onPhoneChange={setPhone}
        t={t}
      />

      <ItemsCard
        items={items}
        products={products}
        fmtMoney={fmtMoney}
        onProductSelect={handleProductSelect}
        onQuantityChange={(i, qty) => updateItem(i, { quantity: qty })}
        onRemove={(i) => setItems((prev) => prev.length <= 1 ? emptyRows(1) : prev.filter((_, j) => j !== i))}
        onAdd={() => setItems((prev) => [...prev, emptyItem()])}
        t={t}
      />

      {filledItems.length > 0 && (
        <p
          className="text-caption"
          style={{
            fontFamily: "var(--font-dm-sans)",
            color: "var(--tone-muted)",
            margin: "0 0 -8px",
            textAlign: "right",
          }}
        >
          {filledItems.length} {filledItems.length === 1 ? "ítem" : "ítems"} · {fmtMoney(total)}
        </p>
      )}

      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "0.875rem 1rem",
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-md)",
        }}
      >
        <span style={{ fontSize: "0.9375rem", fontWeight: 600, color: "var(--tone-muted)" }}>Total</span>
        <span className="text-heading" style={{ color: "var(--tone-strong)" }}>{fmtMoney(total)}</span>
      </div>

      {notice && (
        <p className="text-caption" style={{ color: "var(--tone-muted)", margin: 0, textAlign: "center" }}>
          {notice}
        </p>
      )}

      <div className="flex flex-col gap-2">
        <Button
          type="button"
          onClick={() => void handleSendByWhatsApp()}
          disabled={filledItems.length === 0 || sending}
          className="w-full h-12 gap-2"
        >
          <WhatsappLogoIcon className="icon-base" weight="fill" aria-hidden />
          {sending ? t("Sending…", "Enviando…") : t("Send via WhatsApp", "Enviar por WhatsApp")}
        </Button>

        <div className="flex gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={handleClearRequest}
            className={`flex-1 gap-1.5 ${confirmingClear ? "text-[var(--danger)] border border-[var(--danger)]" : "text-[var(--tone-muted)]"}`}
          >
            <TrashIcon className="icon-sm" aria-hidden />
            {confirmingClear
              ? t("Sure? Delete all", "¿Seguro? Borrar todo")
              : t("Delete quote", "Borrar presupuesto")}
          </Button>
          {confirmingClear && (
            <Button
              type="button"
              variant="outline"
              onClick={() => { setConfirmingClear(false); if (confirmClearTimerRef.current) clearTimeout(confirmClearTimerRef.current); }}
              className="flex-shrink-0"
            >
              {t("Cancel", "Cancelar")}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
