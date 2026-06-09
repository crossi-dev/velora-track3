"use client";

import React, { useMemo, useRef, type CSSProperties } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { MagnifyingGlass as Search, CaretRight as ChevronRight, UserPlus, Truck, X } from "@phosphor-icons/react";
import type { ContactRow as ContactRowData } from "@/domain";
import { useDebouncedValue } from "../lib/hooks/useDebouncedValue";
import { EmptyContactsState } from "./EmptyContactsState";
import { SharedEmptyState } from "./SharedEmptyState";

const CONTACT_ROW_NAME_STYLE: CSSProperties = {
  fontFamily: "var(--font-dm-sans)",
  color: "var(--tone-strong)",
  margin: 0,
};

const CONTACT_ROW_SECONDARY_STYLE: CSSProperties = {
  fontFamily: "var(--font-dm-sans)",
  margin: "2px 0 0",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const CONTACT_BUTTON_STYLE: CSSProperties = {
  background: "none",
  border: "none",
  cursor: "pointer",
};

const CONTACT_CHEVRON_STYLE: CSSProperties = { color: "var(--tone-muted)", flexShrink: 0 };

const ContactRow = React.memo(function ContactRow({
  row,
  isClients,
  setSelectedContactId,
}: {
  row: ContactRowData;
  isClients: boolean;
  setSelectedContactId: (id: string) => void;
}) {
  const secondaryParts: string[] = [];
  if (isClients) {
    if (row.phone) secondaryParts.push(row.phone);
    if (row.email) secondaryParts.push(row.email);
  } else {
    if (row.contactName) secondaryParts.push(row.contactName);
    if (row.phone) secondaryParts.push(row.phone);
  }

  return (
    <button
      type="button"
      data-contact-row-id={row.id}
      onClick={() => setSelectedContactId(row.id)}
      className="list-row w-full text-left"
      style={CONTACT_BUTTON_STYLE}
    >
      <div className="min-w-0 flex-1">
        <p className="text-body-strong" style={CONTACT_ROW_NAME_STYLE}>{row.name}</p>
        {secondaryParts.length > 0 && (
          <p className="text-caption" style={CONTACT_ROW_SECONDARY_STYLE}>{secondaryParts.join(" · ")}</p>
        )}
      </div>
      <ChevronRight className="icon-sm" style={CONTACT_CHEVRON_STYLE} aria-hidden />
    </button>
  );
});

interface ContactsListProps {
  isClients: boolean;
  rows: ContactRowData[];
  bothEmpty: boolean;
  search: string;
  setSearch: (value: string) => void;
  setShowSheet: (value: boolean) => void;
  setSelectedContactId: (id: string) => void;
  t: (en: string, es: string) => string;
}

export function ContactsList({
  isClients,
  rows,
  bothEmpty,
  search,
  setSearch,
  setShowSheet,
  setSelectedContactId,
  t,
}: ContactsListProps) {
  const contactsListRef = useRef<HTMLDivElement>(null);
  const debouncedSearch = useDebouncedValue(search, 300);

  const filtered = useMemo(() => {
    if (!debouncedSearch.trim()) return rows;
    const q = debouncedSearch.trim().toLowerCase();
    return rows.filter((r) =>
      r.name.toLowerCase().includes(q) ||
      (r.phone ?? "").toLowerCase().includes(q) ||
      (r.email ?? "").toLowerCase().includes(q)
    );
  }, [rows, debouncedSearch]);

  const contactsVirtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => contactsListRef.current,
    estimateSize: () => 72,
    overscan: 5,
  });

  return (
    <>
      <div className="flex flex-col gap-2">
        <div className="relative w-full" style={{ display: "flex", alignItems: "center" }}>
          <Search className="icon-xs absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: "var(--tone-muted)" }} aria-hidden />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={isClients ? t("Search customers…", "Buscar clientes…") : t("Search suppliers…", "Buscar proveedores…")}
            aria-label={isClients ? t("Search customers", "Buscar clientes") : t("Search suppliers", "Buscar proveedores")}
            className="text-caption w-full outline-none rounded-pill"
            style={{
              fontFamily: "var(--font-dm-sans)",
              color: "var(--tone-strong)",
              backgroundColor: "var(--surface-subtle)",
              border: "none",
              paddingLeft: "2rem",
              paddingRight: search.length > 0 ? "2.5rem" : "0.875rem",
              height: "2.5rem",
            }}
          />
          {search.length > 0 && (
            <button
              type="button"
              onClick={() => setSearch("")}
              aria-label={t("Clear search", "Limpiar búsqueda")}
              style={{
                position: "absolute",
                right: "0",
                top: "0",
                height: "100%",
                width: "44px",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: "none",
                border: "none",
                cursor: "pointer",
                color: "var(--tone-muted)",
                padding: "10px",
              }}
            >
              <X size={14} weight="bold" />
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={() => setShowSheet(true)}
          className="text-caption w-full inline-flex items-center justify-center gap-1.5 rounded-token-md border px-4 py-2.5 font-semibold"
          style={{
            fontFamily: "var(--font-dm-sans)",
            color: "var(--action-secondary-fg)",
            borderColor: "var(--action-secondary-border)",
            backgroundColor: "transparent",
            minHeight: "2.75rem",
          }}
        >
          {isClients ? <UserPlus className="icon-xs" aria-hidden /> : <Truck className="icon-xs" aria-hidden />}
          {t("New", "Nuevo")}
        </button>
      </div>

      {bothEmpty ? (
        <EmptyContactsState onAddContact={() => setShowSheet(true)} />
      ) : rows.length === 0 ? (
        <SharedEmptyState
          title={
            isClients
              ? t("No customers yet", "Todavía no hay clientes cargados")
              : t("No suppliers yet", "Todavía no hay proveedores cargados")
          }
          description={
            isClients
              ? t("Add your first customer to send them receipts via WhatsApp.", "Agregá tu primer cliente para mandarle comprobantes por WhatsApp.")
              : t("Add a supplier to track your purchases and orders.", "Agregá un proveedor para registrar tus compras y pedidos.")
          }
          action={{
            label: t("New", "Nuevo"),
            onClick: () => setShowSheet(true),
          }}
        />
      ) : filtered.length === 0 ? (
        <p className="text-caption" style={{ fontFamily: "var(--font-dm-sans)", textAlign: "center", padding: "2rem" }}>
          {t("No results for that search.", "No hay resultados para esa búsqueda.")}
        </p>
      ) : (
        <div
          ref={contactsListRef}
          style={{ height: "min(75vh, 680px)", overflowY: "auto" }}
        >
          <div style={{ height: `${contactsVirtualizer.getTotalSize()}px`, position: "relative" }}>
            {contactsVirtualizer.getVirtualItems().map((virtualRow) => {
              const row = filtered[virtualRow.index];
              return (
                <div
                  key={row.id}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  <ContactRow
                    row={row}
                    isClients={isClients}
                    setSelectedContactId={setSelectedContactId}
                  />
                </div>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}
