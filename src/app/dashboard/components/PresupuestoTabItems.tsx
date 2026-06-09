"use client";

import { TrashIcon, PlusIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export interface LineItem {
  id: string;
  productId: string;
  name: string;
  quantity: number;
  unitPrice: number;
}

let _itemSeq = 0;
export function emptyItem(): LineItem {
  return { id: `item-${++_itemSeq}`, productId: "", name: "", quantity: 0, unitPrice: 0 };
}

export function emptyRows(count: number): LineItem[] {
  return Array.from({ length: count }, () => emptyItem());
}

interface CustomerCardProps {
  customerId: string;
  phone: string;
  clients: Array<{ id: string; name: string; phone: string }>;
  onCustomerChange: (id: string, name: string, phone: string) => void;
  onPhoneChange: (phone: string) => void;
  t: (en: string, es: string) => string;
}

export function CustomerCard({ customerId, phone, clients, onCustomerChange, onPhoneChange, t }: CustomerCardProps) {
  return (
    <div
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-md)",
        padding: "1rem",
        display: "flex",
        flexDirection: "column",
        gap: "0.75rem",
      }}
    >
      <span className="t-label" style={{ color: "var(--tone-muted)" }}>
        {t("Customer", "Cliente")}
      </span>
      <div className="flex gap-2 flex-col sm:flex-row">
        <Select
          value={customerId}
          onValueChange={(nextId) => {
            const selected = clients.find((c) => c.id === nextId);
            if (nextId === "__consumidor_final__") {
              onCustomerChange("", "", "");
            } else {
              onCustomerChange(nextId, selected?.name ?? "", selected?.phone ?? "");
            }
          }}
        >
          <SelectTrigger
            className="flex-1 bg-[var(--surface-subtle)] border-transparent focus:border-input focus:bg-background"
            aria-label={t("Customer", "Cliente")}
          >
            <SelectValue placeholder={t("End consumer", "Consumidor Final")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__consumidor_final__">{t("End consumer", "Consumidor Final")}</SelectItem>
            {clients.map((c) => (
              <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          type="tel"
          value={phone}
          onChange={(e) => onPhoneChange(e.target.value)}
          placeholder={t("WhatsApp phone", "Teléfono WhatsApp")}
          aria-label={t("Customer's WhatsApp phone number", "Teléfono WhatsApp del cliente")}
          className="flex-1 bg-[var(--surface-subtle)] border-transparent focus-visible:border-input focus-visible:bg-background"
        />
      </div>
    </div>
  );
}

interface ItemRowProps {
  item: LineItem;
  index: number;
  products: Array<{ id: string; name: string; price: number; stock: number }>;
  fmtMoney: (value: number) => string;
  onProductSelect: (index: number, productId: string) => void;
  onQuantityChange: (index: number, qty: number) => void;
  onRemove: (index: number) => void;
  t: (en: string, es: string) => string;
}

export function ItemRow({ item, index, products, fmtMoney, onProductSelect, onQuantityChange, onRemove, t }: ItemRowProps) {
  const subtotal = item.quantity * item.unitPrice;
  const isQtyEmpty = item.productId && item.quantity === 0;
  return (
    <div
      style={{
        padding: "0.75rem 1rem",
        borderRadius: "var(--radius-md)",
        background: item.productId ? "var(--surface)" : "var(--surface-subtle)",
        border: item.productId ? "1px solid var(--border)" : "1px solid transparent",
        display: "flex",
        flexDirection: "column",
        gap: "0.5rem",
        opacity: isQtyEmpty ? 0.5 : 1,
        transition: "opacity 120ms ease",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
        <Select
          value={item.productId || undefined}
          onValueChange={(productId) => onProductSelect(index, productId)}
        >
          <SelectTrigger
            className="flex-1 border-transparent bg-transparent focus:border-input focus:bg-background text-[0.9375rem]"
            aria-label={t("Select product", "Seleccionar producto")}
          >
            <SelectValue placeholder={t("Select product…", "Seleccionar producto…")} />
          </SelectTrigger>
          <SelectContent>
            {products.map((p) => (
              <SelectItem key={p.id} value={p.id}>{p.name} — {fmtMoney(p.price)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() => onRemove(index)}
          aria-label={t("Remove item", "Eliminar ítem")}
          className="flex-shrink-0 text-[var(--tone-muted)] h-8 w-8"
        >
          <TrashIcon className="icon-sm" aria-hidden />
        </Button>
      </div>
      {item.productId && (
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
          <span className="text-caption" style={{ color: "var(--tone-muted)" }}>{t("Qty.", "Cant.")}</span>
          <Input
            type="number"
            inputMode="numeric"
            min="1"
            value={item.quantity || ""}
            placeholder="1"
            step={1}
            aria-label={t("Quantity", "Cantidad")}
            onChange={(e) => onQuantityChange(index, Math.max(0, Math.floor(Number(e.target.value) || 0)))}
            className="w-16 h-8 text-center font-semibold bg-[var(--surface-subtle)] border-transparent focus-visible:border-input focus-visible:bg-background"
          />
          <span className="text-caption" style={{ color: "var(--tone-muted)" }}>× {fmtMoney(item.unitPrice)}</span>
          <span style={{ marginLeft: "auto", fontSize: "0.9375rem", fontWeight: 700, color: isQtyEmpty ? "var(--tone-muted)" : "var(--tone-strong)" }}>
            {fmtMoney(subtotal)}
          </span>
        </div>
      )}
    </div>
  );
}

interface ItemsCardProps {
  items: LineItem[];
  products: Array<{ id: string; name: string; price: number; stock: number }>;
  fmtMoney: (value: number) => string;
  onProductSelect: (index: number, productId: string) => void;
  onQuantityChange: (index: number, qty: number) => void;
  onRemove: (index: number) => void;
  onAdd: () => void;
  t: (en: string, es: string) => string;
}

export function ItemsCard({ items, products, fmtMoney, onProductSelect, onQuantityChange, onRemove, onAdd, t }: ItemsCardProps) {
  return (
    <div
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-md)",
        padding: "1rem",
        display: "flex",
        flexDirection: "column",
        gap: "0.5rem",
      }}
    >
      <span className="t-label" style={{ color: "var(--tone-muted)", marginBottom: "0.25rem" }}>
        {t("Products", "Productos")}
      </span>
      {items.map((item, index) => (
        <ItemRow
          key={item.id}
          item={item}
          index={index}
          products={products}
          fmtMoney={fmtMoney}
          onProductSelect={onProductSelect}
          onQuantityChange={onQuantityChange}
          onRemove={onRemove}
          t={t}
        />
      ))}
      <Button
        type="button"
        variant="ghost"
        onClick={onAdd}
        className="w-full gap-1.5 border border-dashed border-[var(--border)] text-[var(--brand)] hover:text-[var(--brand)] hover:bg-transparent"
      >
        <PlusIcon className="icon-base" weight="bold" aria-hidden />
        {t("Add item", "Agregar ítem")}
      </Button>
    </div>
  );
}
