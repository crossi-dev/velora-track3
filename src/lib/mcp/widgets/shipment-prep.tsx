// shipment-prep.tsx — MCP App widget: combined stock + shipping preview.
//
// READ-ONLY — this widget never calls a money-mutating or shipment-creating tool.
// Shows, for a set of catalog items + a shipping destination: each item's stock
// status and price, the computed package weight, and the shipping quote options
// from every active courier — all on one screen (single tool call, single widget,
// per SEP-1865 / MCP Apps — one tool maps to one widget).
//
// Design principles (mirrors delivery-receipt.tsx / catalog-selector.tsx):
//   - Native semantic elements: <main>, <section>, <ul>, <li> (W3C First Rule of ARIA).
//   - Chameleon theming: Tailwind v4 mapped to host CSS variables via useHostStyleVariables/useHostFonts.
//   - Typography: rem units, ≥ 0.875rem (14px) minimum per 2026 WCAG 2.2 AA standards.
//   - No Zod, no eval — all data from structuredContent.prefill.
//
// Data contract: structuredContent.prefill from open_shipment_prep tool.
//   prefill = { items, totalWeightGrams, hasRealWeightData, shipping }.
//
// CSP: no allowUnsafeEval — do NOT add it.

import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { useApp, useHostStyleVariables, useHostFonts } from "@modelcontextprotocol/ext-apps/react";
import { Card, Centered, StatusChip } from "./_widget-primitives";

// ── Data contract (matches shipment-prep-render.ts) ──────────────────────────

interface ShipmentItem {
  productId: string;
  quantity: number;
  found: boolean;
  name: string | null;
  unitPrice: number | null;
  stock: number | null;
  sufficientStock: boolean;
  weightGrams: number;
}

interface ShippingOption {
  provider: string;
  service: string;
  serviceLabel: string;
  priceARS: number;
  estimatedDays: number;
}

interface ShippingInfo {
  options: ShippingOption[];
  cheapestPriceARS: number | null;
  activeCourierCount: number;
  originPostalCode: string;
  destinationPostalCode: string;
}

interface Prefill {
  items: ShipmentItem[];
  totalWeightGrams: number;
  hasRealWeightData: boolean;
  shipping: ShippingInfo;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatARS(pesos: number): string {
  return "$ " + pesos.toLocaleString("es-AR", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function formatWeight(grams: number): string {
  return grams >= 1000 ? `${(grams / 1000).toLocaleString("es-AR", { maximumFractionDigits: 2 })} kg` : `${grams} g`;
}

// Same cap convention as cobro-status.tsx's LINE_ITEMS_CAP / pending-orders.tsx's DISPLAY_CAP.
const LIST_CAP = 10;

// ── Main widget ───────────────────────────────────────────────────────────────

function ShipmentPrepWidget(): React.JSX.Element {
  const { app, isConnected, error } = useApp({
    appInfo: { name: "shipment-prep", version: "1.0.0" },
    capabilities: {},
  });
  useHostStyleVariables(app, app?.getHostContext());
  useHostFonts(app, app?.getHostContext());

  const [prefill, setPrefill] = useState<Prefill | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!app) return;
    // Render data arrives ONLY via ontoolresult (ui/notifications/tool-result → structuredContent).
    // ontoolinput is intentionally NOT wired: it carries the tool INPUT args (no resolved fields) and would flash NaN/undefined.
    const apply = (params: { structuredContent?: unknown; arguments?: unknown }) => {
      const raw = (params.structuredContent ?? params.arguments ?? {}) as { prefill?: Prefill } & Prefill;
      const args = (raw.prefill ?? raw) as Prefill;
      setPrefill(args);
      setLoaded(true);
    };
    app.ontoolresult = (params) => apply(params);
  }, [app]);

  if (error) return <Centered>No pudimos abrir la vista previa de envío. {error.message}</Centered>;
  if (!isConnected) return <Centered>Conectando…</Centered>;
  if (!loaded) return <Centered>Cargando…</Centered>;
  if (!prefill || prefill.items.length === 0) {
    return <Centered>No hay productos para preparar el envío.</Centered>;
  }

  const { items, totalWeightGrams, hasRealWeightData, shipping } = prefill;
  const anyInsufficientStock = items.some((it) => !it.found || !it.sufficientStock);

  // Safe areas (claude.com/docs/connectors/building/mcp-apps/design-guidelines
  // #host-context-for-layout): add hostContext.safeAreaInsets on top of the
  // base p-5 padding so the chat composer/nav bar never overlaps this widget.
  const safeArea = app?.getHostContext()?.safeAreaInsets;
  const safeAreaStyle: React.CSSProperties = safeArea
    ? {
        paddingTop: `calc(1.25rem + ${safeArea.top}px)`,
        paddingRight: `calc(1.25rem + ${safeArea.right}px)`,
        paddingBottom: `calc(1.25rem + ${safeArea.bottom}px)`,
        paddingLeft: `calc(1.25rem + ${safeArea.left}px)`,
      }
    : {};

  return (
    <Card title="Preparar envío" style={safeAreaStyle}>
      {/* Items block */}
      <section aria-label="Productos">
        <h2 className="mb-2 text-sm font-medium text-ink-soft">Productos</h2>
        <ul className="flex flex-col gap-2">
          {items.slice(0, LIST_CAP).map((it, idx) => (
            <li
              key={`${it.productId}:${idx}`}
              className="flex items-center justify-between gap-3 rounded-control bg-surface-2 p-3"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-base text-ink">
                  {it.quantity}× {it.found ? it.name : `Producto ${it.productId}`}
                </div>
                <div className="text-sm tabular-nums text-ink-soft">
                  {it.found && it.unitPrice !== null ? formatARS(it.unitPrice * it.quantity) : "Precio no disponible"}
                </div>
              </div>
              <span className="shrink-0">
                <StatusChip tone={it.found && it.sufficientStock ? "neutral" : "danger"}>
                  {!it.found ? "No encontrado" : it.sufficientStock ? `Stock: ${it.stock}` : `Sin stock suficiente (${it.stock ?? 0})`}
                </StatusChip>
              </span>
            </li>
          ))}
        </ul>
        {items.length > LIST_CAP && (
          <p className="mt-2 text-sm text-ink-soft">
            y {items.length - LIST_CAP} producto{items.length - LIST_CAP !== 1 ? "s" : ""} más
          </p>
        )}
        {anyInsufficientStock && (
          <p className="mt-2 text-sm text-danger-ink" role="alert">
            Algunos productos no tienen stock suficiente para esta cantidad.
          </p>
        )}
      </section>

      {/* Weight block */}
      <section aria-label="Peso del paquete" className="rounded-control bg-surface-2 px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm text-ink-soft">Peso estimado del paquete</span>
          <span className="text-base font-semibold tabular-nums text-ink">{formatWeight(totalWeightGrams)}</span>
        </div>
        {!hasRealWeightData && (
          <p className="mt-1 text-sm text-ink-soft">
            Estimado — algunos productos no tienen peso cargado (se usó 500 g por unidad).
          </p>
        )}
      </section>

      {/* Shipping block */}
      <section aria-label="Cotización de envío">
        <h2 className="mb-2 text-sm font-medium text-ink-soft">Envío</h2>
        {shipping.activeCourierCount === 0 ? (
          <div className="rounded-control bg-surface-2 px-4 py-3 text-sm text-ink-soft">
            No hay couriers activos para este negocio. El dueño debe conectar un courier en Configuración.
          </div>
        ) : shipping.options.length === 0 ? (
          <div className="rounded-control bg-surface-2 px-4 py-3 text-sm text-ink-soft">
            No se pudo cotizar el envío con los couriers activos. Probá de nuevo.
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {shipping.options.slice(0, LIST_CAP).map((opt, idx) => (
              <li
                key={`${opt.provider}:${opt.service}:${idx}`}
                className="flex items-center justify-between gap-3 rounded-control bg-surface-2 p-3"
              >
                <div className="min-w-0">
                  <div className="truncate text-base text-ink">{opt.serviceLabel}</div>
                  <div className="text-sm text-ink-soft">
                    {opt.provider} · {opt.estimatedDays > 0 ? `${opt.estimatedDays} días` : "plazo no informado"}
                  </div>
                </div>
                <span className="shrink-0 text-base font-semibold tabular-nums text-ink">
                  {formatARS(opt.priceARS)}
                  {shipping.cheapestPriceARS === opt.priceARS && (
                    <span className="ml-2 rounded-full bg-surface-2 px-2 py-0.5 text-sm font-medium text-ink-soft">
                      Más barato
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
        {shipping.options.length > LIST_CAP && (
          <p className="mt-2 text-sm text-ink-soft">
            y {shipping.options.length - LIST_CAP} opci{shipping.options.length - LIST_CAP !== 1 ? "ones" : "ón"} más
          </p>
        )}
      </section>
    </Card>
  );
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

const rootEl = document.getElementById("root");
if (rootEl) createRoot(rootEl).render(<ShipmentPrepWidget />);
