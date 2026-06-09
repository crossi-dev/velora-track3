// customer-field.tsx — Inline customer selector for the payment-link wizard.
//
// Extracted from payment-link-wizard.tsx to keep each file under the 300-line
// server/lib limit (scripts/check-file-size.mjs).
//
// Pattern: Stripe "select an existing customer" inline edit
// (docs.stripe.com/get-started/use-cases/invoices — verified HTTP 200 2026-06-07).
// No modal, no nested scroll. Max 6 results (caller slices). Native semantic
// elements (input, listbox) per W3C First Rule of ARIA.
//
// CustomerMatch maps the CustomerSearchResult shape from find_customer:
// content[0].text = JSON.stringify({ customers: CustomerSearchResult[], total: number })
// See: src/lib/mcp/customer-tools.ts + src/lib/mcp/_lib/customer-backend.port.ts

import React from "react";

// Subset of CustomerSearchResult — only the fields the picker needs to display
// and to set after selection (id + customerName for the wizard, phone for display).
export interface CustomerMatch {
  id: string;
  name: string;
  phone: string | null;
}

export interface CustomerFieldProps {
  customerName: string;
  pickingCustomer: boolean;
  customerQuery: string;
  customerMatches: CustomerMatch[];
  searchingCustomer: boolean;
  customerSearchError: string | null;
  onStartPick: () => void;
  onCancelPick: () => void;
  onQueryChange: (v: string) => void;
  onSearch: () => void;
  onPickCustomer: (m: CustomerMatch) => void;
}

export function CustomerField({
  customerName,
  pickingCustomer,
  customerQuery,
  customerMatches,
  searchingCustomer,
  customerSearchError,
  onStartPick,
  onCancelPick,
  onQueryChange,
  onSearch,
  onPickCustomer,
}: CustomerFieldProps): React.JSX.Element {
  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") { e.preventDefault(); onSearch(); }
    if (e.key === "Escape") onCancelPick();
  }

  return (
    <div>
      <div className="mb-1 text-sm text-ink-soft">Cliente</div>
      {!pickingCustomer ? (
        <div className="flex items-center gap-2">
          <span className="text-base text-ink">{customerName}</span>
          <button
            type="button"
            onClick={onStartPick}
            className="text-sm text-accent underline-offset-2 hover:underline"
          >
            Cambiar
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="flex gap-2">
            <input
              type="search"
              autoFocus
              placeholder="Buscar cliente por nombre…"
              value={customerQuery}
              onChange={(e) => onQueryChange(e.target.value)}
              onKeyDown={handleKeyDown}
              className="flex-1 rounded-control border border-line bg-surface px-3 py-2 text-sm text-ink outline-none focus:border-accent"
            />
            <button
              type="button"
              onClick={onSearch}
              disabled={searchingCustomer || !customerQuery.trim()}
              className="rounded-control bg-accent px-3 py-2 text-sm font-medium text-on-accent disabled:opacity-60"
            >
              {searchingCustomer ? "…" : "Buscar"}
            </button>
            <button
              type="button"
              onClick={onCancelPick}
              className="rounded-control border border-line px-3 py-2 text-sm text-ink-soft"
            >
              Cancelar
            </button>
          </div>
          {customerSearchError && (
            <p className="text-sm text-danger-ink" role="alert">{customerSearchError}</p>
          )}
          {customerMatches.length > 0 && (
            <ul role="listbox" aria-label="Clientes encontrados" className="flex flex-col gap-1">
              {customerMatches.map((m) => (
                <li key={m.id}>
                  <button
                    type="button"
                    onClick={() => onPickCustomer(m)}
                    className="w-full rounded-control bg-surface-2 px-3 py-2 text-left text-sm text-ink hover:bg-line"
                  >
                    <span className="font-medium">{m.name}</span>
                    {m.phone && <span className="ml-2 text-ink-soft">{m.phone}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
