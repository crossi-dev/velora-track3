"use client";
import React from "react";
import { CheckCircle, ArrowUp, ArrowsLeftRight, Package, Receipt, Check } from "@phosphor-icons/react";
import { formatTimestamp } from "./chat-helpers";

type IconCmp = React.ComponentType<{ size?: number; color?: string; "aria-hidden"?: boolean }>;
type Meta = { Icon: IconCmp; color: string; label: string; detail: string };
const mk = (Icon: IconCmp, color: string, label: string, detail = ""): Meta => ({ Icon, color, label, detail });

function parseMeta(text: string): Meta {
  let r: RegExpMatchArray | null;
  // Sale
  if ((r = text.match(/and invoice .+ for (.+)$/i))) return mk(CheckCircle, "var(--success)", "Venta", r[1]);
  if (text.toLowerCase().startsWith("venta registrada ")) {
    for (const s of [" — ", " – ", " - "]) {
      const i = text.lastIndexOf(s);
      if (i > 0) return mk(CheckCircle, "var(--success)", "Venta", text.slice(i + s.length).trim());
    }
    return mk(CheckCircle, "var(--success)", "Venta");
  }
  if (/^(Venta registrada|Sale recorded)\.$/i.test(text)) return mk(CheckCircle, "var(--success)", "Venta");
  // Stock
  if ((r = text.match(/^Carga de stock de (\d+) (.+)$/i))) return mk(ArrowUp, "var(--brand)", "Stock", `+${r[1]}u ${r[2]}`);
  if ((r = text.match(/^Stock actualizado\.\s*(.*)$/i))) return mk(ArrowUp, "var(--brand)", "Stock", r[1]);
  // Cash movement
  if ((r = text.match(/^Movimiento de caja registrado:\s*(.+)$/i))) return mk(ArrowsLeftRight, "var(--tone-muted)", "Caja", r[1]);
  if (/^Movimiento registrado\.$/i.test(text)) return mk(ArrowsLeftRight, "var(--tone-muted)", "Movimiento");
  // Products
  if ((r = text.match(/^Producto (creado|actualizado|eliminado):\s*(.+)$/i)))
    return mk(Package, r[1] === "eliminado" ? "var(--danger)" : "var(--tone-muted)", r[1] === "actualizado" ? "Precio" : "Producto", r[2]);
  if (/^Producto agregado\.$/i.test(text)) return mk(Package, "var(--tone-muted)", "Producto");
  // Invoices
  if ((r = text.match(/^Factura (enviada|cobrada)\.\s*(.*)$/i)))
    return mk(Receipt, r[1] === "cobrada" ? "var(--success)" : "var(--tone-muted)", r[1] === "cobrada" ? "Cobrada" : "Factura", r[2]);
  // Contacts
  if ((r = text.match(/^(Cliente|Proveedor)/i))) return mk(Check, "var(--tone-muted)", r[1]);
  return mk(Check, "var(--tone-muted)", "Listo", text.slice(0, 50));
}

export function ActivityRow({ text, timestamp }: { text: string; timestamp?: number }) {
  const { Icon, color, label, detail } = parseMeta(text);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "8px", minHeight: "44px", padding: "0 16px", fontFamily: "var(--font-dm-sans)" }}>
      <Icon size={16} color={color} aria-hidden />
      <span style={{ fontSize: "0.875rem", fontWeight: 500, color: "var(--tone-strong)" }}>{label}</span>
      {detail ? <span style={{ fontSize: "0.875rem", color: "var(--tone-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>· {detail}</span> : null}
      <span style={{ fontSize: "0.875rem", color: "var(--tone-muted)", marginLeft: "auto", flexShrink: 0 }}>{formatTimestamp(timestamp)}</span>
    </div>
  );
}
