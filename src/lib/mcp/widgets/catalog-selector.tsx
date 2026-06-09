// catalog-selector.tsx — MCP App widget for browsing the product catalog and
// selecting items before handing off to the payment-link wizard or the model.
//
// Design principles (all industry-sourced, HTTP 200 verified 2026-06-07):
//  - Editable quantity per product row (default 0 — nothing selected until the
//    owner explicitly sets a quantity). Matches Stripe adjustable-quantity
//    (docs.stripe.com/payments/checkout/adjustable-quantity) and Baymard
//    checkout research (baymard.com/research/checkout-usability).
//  - One primary action "Confirmar selección" — OpenAI Apps SDK UI guidelines
//    (developers.openai.com/apps-sdk/concepts/ui-guidelines).
//  - Native semantic elements for a11y (W3C First Rule of ARIA, w3.org/TR/using-aria).
//  - Chameleon theming: Tailwind v4 mapped (widget.css @theme) to the host's
//    MCP-App CSS variables via ext-apps useHostStyleVariables/useHostFonts.
//
// Data contract: receives UCP Catalog products (https://ucp.dev/latest/specification/catalog/)
// from the render tool via app.ontoolresult (structuredContent). The widget is READ-ONLY — it never
// calls a money-mutating tool. The confirm step surfaces the selection as a
// human-readable summary and invites the model (Velora) to continue.
//
// CSP: no `allowUnsafeEval`. Do NOT add it without a CSP audit.

import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { useApp, useHostStyleVariables, useHostFonts } from "@modelcontextprotocol/ext-apps/react";
import { Card, PrimaryButton, SecondaryButton, Centered } from "./_widget-primitives";

// ── Cobrar action state ───────────────────────────────────────────────────────
// open_payment_link_wizard input item shape (matches WIZARD_ITEM_SCHEMA in payments-tools.ts)
interface WizardItem {
  productId: string;
  quantity: number;
}

// ── UCP Catalog types (ucp.dev/latest/specification/catalog/) ─────────────────

interface UCPAmount {
  amount: number;    // integer, ISO 4217 minor units (centavos for ARS)
  currency: string;  // ISO 4217 code
}

interface UCPPriceRange {
  min: UCPAmount;
  max: UCPAmount;
}

interface UCPVariant {
  id: string;
  sku?: string;
  availability: { in_stock: boolean; quantity?: number };
  price: UCPAmount;
}

interface UCPProduct {
  id: string;
  title: string;
  description: string;
  price_range: UCPPriceRange;
  variants: UCPVariant[];
}

interface Prefill {
  products: UCPProduct[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Format minor-unit integer amount + currency as locale string (es-AR). */
function formatAmount(amount: UCPAmount): string {
  const pesos = amount.amount / 100;
  return (
    (amount.currency === "ARS" ? "$ " : amount.currency + " ") +
    pesos.toLocaleString("es-AR", { minimumFractionDigits: 0, maximumFractionDigits: 2 })
  );
}

function stockLabel(variant: UCPVariant): string {
  if (!variant.availability.in_stock) return "Sin stock";
  const qty = variant.availability.quantity;
  return qty !== undefined ? `Stock: ${qty}` : "En stock";
}

// ── Main widget ───────────────────────────────────────────────────────────────

function CatalogSelector(): React.JSX.Element {
  const { app, isConnected, error } = useApp({
    appInfo: { name: "catalog-selector", version: "1.0.0" },
    capabilities: {},
  });
  useHostStyleVariables(app, app?.getHostContext());
  useHostFonts(app, app?.getHostContext());

  const [products, setProducts] = useState<UCPProduct[]>([]);
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [confirmed, setConfirmed] = useState(false);
  const [toolResultReceived, setToolResultReceived] = useState(false);
  const [openingWizard, setOpeningWizard] = useState(false);
  const [wizardErrMsg, setWizardErrMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!app) return;
    // Render data arrives ONLY via ontoolresult (ui/notifications/tool-result → structuredContent).
    // ontoolinput is intentionally NOT wired: it carries the tool INPUT args (no resolved fields) and would flash NaN/undefined.
    const apply = (params: { structuredContent?: unknown; arguments?: unknown }) => {
      // Mark that a result was received regardless of whether it's usable.
      // This distinguishes "still waiting" from "result arrived but unusable"
      // so we can show an error state instead of infinite "Cargando…".
      setToolResultReceived(true);
      const raw = (params.structuredContent ?? params.arguments ?? {}) as { prefill?: Prefill } & Prefill;
      const args = (raw.prefill ?? raw) as Prefill;
      const list = args.products ?? [];
      setProducts(list);
      // Reset quantities when a new catalog arrives
      const initial: Record<string, number> = {};
      for (const p of list) initial[p.id] = 0;
      setQuantities(initial);
      setConfirmed(false);
    };
    app.ontoolresult = (params) => apply(params);
  }, [app]);

  function setQty(productId: string, next: number) {
    const q = Math.max(0, Math.floor(Number.isFinite(next) ? next : 0));
    setQuantities((prev) => ({ ...prev, [productId]: q }));
  }

  const selectedItems = products.filter((p) => (quantities[p.id] ?? 0) > 0);
  const grandTotal: UCPAmount = {
    amount: selectedItems.reduce((sum, p) => sum + p.price_range.min.amount * (quantities[p.id] ?? 0), 0),
    currency: selectedItems[0]?.price_range.min.currency ?? "ARS",
  };

  function onConfirm() {
    setConfirmed(true);
  }

  // Map selected items to the wizard's expected item shape (productId + quantity).
  // The wizard resolves prices server-side (NABAOS) — we send IDs only.
  async function onCobrarCliente() {
    if (!app || selectedItems.length === 0) return;
    setOpeningWizard(true);
    setWizardErrMsg(null);
    const wizardItems: WizardItem[] = selectedItems.map((p) => ({
      productId: p.id,
      quantity: quantities[p.id] ?? 1,
    }));
    try {
      const result = await app.callServerTool({
        name: "open_payment_link_wizard",
        arguments: {
          description: selectedItems.map((p) => `${quantities[p.id]}× ${p.title}`).join(", "),
          items: wizardItems,
          // customerId intentionally omitted — wizard's in-widget customer picker handles selection
        },
      });
      if (result.isError) {
        const raw = (result.content?.[0] as { text?: string } | undefined)?.text ?? "{}";
        let msg = "No se pudo abrir el asistente de cobro.";
        try { const p = JSON.parse(raw) as { message?: string }; msg = p.message ?? msg; } catch { /* default */ }
        setWizardErrMsg(msg);
      }
    } catch {
      setWizardErrMsg("No se pudo abrir el asistente de cobro. Intentá de nuevo.");
    } finally {
      setOpeningWizard(false);
    }
  }

  if (error) return <Centered>No pudimos abrir el selector de catálogo. {error.message}</Centered>;
  if (!isConnected) return <Centered>Conectando…</Centered>;
  if (!products.length && toolResultReceived) return <Centered>No pudimos cargar el catálogo. Probá de nuevo.</Centered>;
  if (!products.length) return <Centered>Cargando catálogo…</Centered>;

  if (confirmed) {
    return (
      <Card title="Selección lista">
        {selectedItems.length === 0 ? (
          <p className="text-base text-ink-soft">No seleccionaste ningún producto.</p>
        ) : (
          <>
            <p className="text-sm text-ink-soft">
              Decile a Velora a qué cliente querés cobrarle y generamos el link.
            </p>
            <ul className="flex flex-col gap-2">
              {selectedItems.map((p) => {
                const qty = quantities[p.id] ?? 0;
                const unitAmount = p.price_range.min.amount;
                const subtotal: UCPAmount = {
                  amount: unitAmount * qty,
                  currency: p.price_range.min.currency,
                };
                return (
                  <li
                    key={p.id}
                    className="flex items-center justify-between gap-3 rounded-control bg-surface-2 p-3"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-base text-ink">{p.title}</div>
                      <div className="text-sm text-ink-soft">
                        {qty}× {formatAmount(p.price_range.min)} ={" "}
                        {formatAmount(subtotal)}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
            <div className="flex items-center justify-between rounded-control bg-surface-2 p-3">
              <span className="text-base text-ink-soft">Total</span>
              <span className="text-lg font-semibold text-ink">{formatAmount(grandTotal)}</span>
            </div>
            <div className="rounded-control bg-surface-2 p-3 text-sm text-ink-soft">
              <strong className="text-ink">
                Seleccionaste:{" "}
                {selectedItems
                  .map((p) => `${quantities[p.id]}× ${p.title}`)
                  .join(", ")}
              </strong>
              {" — "}decile a Velora a qué cliente cobrarle.
            </div>
            {wizardErrMsg && (
              <p className="text-sm text-danger-ink" role="alert">{wizardErrMsg}</p>
            )}
            {/* Cobrar: opens payment-link wizard without a customer — the owner picks one in-widget */}
            <PrimaryButton disabled={openingWizard} onClick={onCobrarCliente}>
              {openingWizard ? "Abriendo…" : "Cobrar a cliente"}
            </PrimaryButton>
          </>
        )}
        <SecondaryButton onClick={() => setConfirmed(false)}>Editar selección</SecondaryButton>
      </Card>
    );
  }

  return (
    <Card title="Catálogo de productos">
      <ul className="flex flex-col gap-2">
        {products.map((p) => {
          const variant = p.variants[0];
          const qty = quantities[p.id] ?? 0;
          const inStock = variant?.availability.in_stock ?? false;
          return (
            <li
              key={p.id}
              className="flex items-center justify-between gap-3 rounded-control bg-surface-2 p-3"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-base text-ink">{p.title}</div>
                <div className="text-sm text-ink-soft">
                  {formatAmount(p.price_range.min)}
                  {" · "}
                  <span className={inStock ? "text-ink-soft" : "text-danger-ink"}>
                    {variant ? stockLabel(variant) : "Sin info"}
                  </span>
                </div>
              </div>
              <label className="flex items-center gap-1 text-sm text-ink-soft shrink-0">
                <span className="sr-only">Cantidad de {p.title}</span>
                <input
                  type="number"
                  min={0}
                  inputMode="numeric"
                  disabled={!inStock}
                  className="w-16 rounded-control border border-line bg-surface px-2 py-2 text-center text-base text-ink outline-none focus:border-accent disabled:opacity-40"
                  value={qty}
                  onChange={(e) => setQty(p.id, parseInt(e.target.value, 10))}
                />
              </label>
            </li>
          );
        })}
      </ul>

      {selectedItems.length > 0 && (
        <div className="text-sm text-ink-soft">
          Seleccionado: {selectedItems.map((p) => `${quantities[p.id]}× ${p.title}`).join(", ")}
        </div>
      )}

      <p className="text-sm text-ink-soft">
        Ingresá la cantidad de cada producto que querés cobrar (0 = no incluir).
      </p>

      <PrimaryButton disabled={selectedItems.length === 0} onClick={onConfirm}>
        Confirmar selección
      </PrimaryButton>
    </Card>
  );
}

const rootEl = document.getElementById("root");
if (rootEl) createRoot(rootEl).render(<CatalogSelector />);
