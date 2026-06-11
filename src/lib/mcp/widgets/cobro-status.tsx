// cobro-status.tsx — MCP App widget for the owner's cobro status view.
//
// READ-ONLY — this widget never calls a money-mutating tool.
// It displays ONE PaymentIntent status: Pagado / Esperando pago / Vencido / Cancelado,
// plus the customer name, items summary, total in ARS, and dates.
//
// Design principles (industry-sourced, HTTP 200 verified):
//   - Full-bleed status banner per Material Design 3 status chip guidelines
//     (m3.material.io/components/chips/guidelines) and OpenAI Apps SDK UI guidelines
//     (developers.openai.com/apps-sdk/concepts/ui-guidelines).
//   - Native semantic elements: <main>, <section>, <ul>, <li>, <time> (W3C First Rule of ARIA).
//   - Chameleon theming: Tailwind v4 mapped to host CSS variables via
//     ext-apps useHostStyleVariables/useHostFonts.
//   - Typography: rem units, ≥ 0.875rem (14px) minimum per 2026 standards.
//   - Action buttons only for confirmed (→ delivery receipt) and pending with link (copy link).
//
// Data contract: structuredContent.prefill.order from open_cobro_status tool.
// order is { ucp: UCPOrder, customerName, statusLabel, estado, createdAt, confirmedAt? }
// or null when the cobro was not found.
// customerName, statusLabel, estado, and dates are Velora display extensions alongside UCP Order.
//
// UCP Order spec: https://ucp.dev/latest/specification/order/
// CSP: no allowUnsafeEval — do NOT add it without a CSP audit.

import React, { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { useApp, useHostStyleVariables, useHostFonts } from "@modelcontextprotocol/ext-apps/react";
import type { UCPOrder, UCPTotal } from "../_lib/ucp-types";
import { SecondaryButton, Centered } from "./_widget-primitives";

// ── Velora display extensions (not UCP fields) ────────────────────────────────

type CobroEstado = "pending" | "confirmed" | "expired" | "cancelled";

interface DisplayOrder {
  ucp: UCPOrder;
  customerName: string;
  statusLabel: string;
  estado: CobroEstado;
  createdAt: string;          // ISO date string
  confirmedAt: string | null; // ISO date string or null
}

interface Prefill {
  order: DisplayOrder | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Total amount from UCP totals array (type="total"). Falls back to first total. */
function resolveTotal(totals: UCPTotal[]): number {
  const t = totals.find((x) => x.type === "total") ?? totals[0];
  return t ? t.amount : 0;
}

/** Format minor-unit integer as ARS pesos (es-AR locale). */
function formatARS(minorUnits: number): string {
  const pesos = minorUnits / 100;
  return "$ " + pesos.toLocaleString("es-AR", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

/** Format ISO date as short es-AR date ("6 jun. 2026"). */
function formatDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("es-AR", { day: "numeric", month: "short", year: "numeric" });
}

// ── Status chip configuration ─────────────────────────────────────────────────

interface ChipConfig {
  label: string;
  /** Tailwind utility classes for layout/spacing (not color). */
  classes: string;
  /** Inline color style — uses light-dark() for dark-mode safety. Undefined = no inline style needed. */
  colorStyle?: React.CSSProperties;
}

function resolveChipConfig(estado: CobroEstado): ChipConfig {
  switch (estado) {
    case "confirmed":
      return {
        label: "Pagado ✓",
        classes: "",
        // Mirror the onboarding "Conectado" chip pattern: light-dark() vars, not raw Tailwind palette.
        colorStyle: { color: "light-dark(#117a3d, #4ade80)", background: "light-dark(#e7f6ec, #16331f)" },
      };
    case "pending":
      return {
        label: "Esperando pago",
        classes: "bg-surface-2 text-ink-soft",
      };
    case "expired":
      return {
        label: "Vencido",
        classes: "bg-danger-surface text-danger-ink",
      };
    case "cancelled":
      return {
        label: "Cancelado",
        classes: "bg-danger-surface text-danger-ink",
      };
  }
}

// ── Main widget ───────────────────────────────────────────────────────────────

function CobroStatusWidget(): React.JSX.Element {
  const { app, isConnected, error } = useApp({
    appInfo: { name: "cobro-status", version: "1.0.0" },
    capabilities: {},
  });
  useHostStyleVariables(app, app?.getHostContext());
  useHostFonts(app, app?.getHostContext());

  const [order, setOrder] = useState<DisplayOrder | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [navErr, setNavErr] = useState<string | null>(null);

  useEffect(() => {
    if (!app) return;
    // Render data arrives ONLY via ontoolresult (ui/notifications/tool-result → structuredContent).
    // ontoolinput is intentionally NOT wired: it carries the tool INPUT args (no resolved fields) and would flash NaN/undefined.
    const apply = (params: { structuredContent?: unknown; arguments?: unknown }) => {
      const raw = (params.structuredContent ?? params.arguments ?? {}) as { prefill?: Prefill } & Prefill;
      const args = (raw.prefill ?? raw) as Prefill;
      setOrder(args.order ?? null);
      setLoaded(true);
    };
    app.ontoolresult = (params) => apply(params);
  }, [app]);

  const onViewReceipt = useCallback(async () => {
    if (!app || !order) return;
    setNavErr(null);
    await app.callServerTool({ name: "open_delivery_receipt", arguments: { paymentIntentId: order.ucp.id } }).catch(() => {
      setNavErr("No se pudo abrir el comprobante. Intentá de nuevo.");
    });
  }, [app, order]);

  if (error) {
    return <Centered>No pudimos abrir el estado del cobro. {error.message}</Centered>;
  }
  if (!isConnected) return <Centered>Conectando…</Centered>;
  if (!loaded) return <Centered>Cargando estado del cobro…</Centered>;
  if (order === null) {
    return <Centered>No encontré ese cobro.</Centered>;
  }

  // TypeScript: order is DisplayOrder here — both `null` and !loaded are guarded above.
  const detail: DisplayOrder = order;
  const total = resolveTotal(detail.ucp.totals);
  const chip = resolveChipConfig(detail.estado);

  return (
    <main className="mx-auto flex max-w-md flex-col gap-5 p-5 text-ink">
      {/* BIG status banner */}
      <section
        aria-label="Estado del cobro"
        className={`flex items-center justify-center rounded-control px-4 py-3 text-lg font-semibold ${chip.classes}`}
        style={chip.colorStyle}
      >
        {chip.label}
      </section>

      {/* Customer + total */}
      <section className="flex flex-col gap-1 rounded-control bg-surface-2 px-4 py-3">
        <span className="text-base font-medium text-ink">{detail.customerName}</span>
        <span className="text-xl font-bold text-ink">{formatARS(total)}</span>
      </section>

      {/* Line items */}
      {detail.ucp.line_items.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-medium text-ink-soft">Productos</h2>
          <ul className="flex flex-col gap-2">
            {detail.ucp.line_items.map((li) => (
              <li
                key={li.id}
                className="flex items-center justify-between gap-2 rounded-control bg-surface-2 px-4 py-3"
              >
                <span className="text-base text-ink">
                  {li.quantity}× {li.item.title}
                </span>
                <span className="shrink-0 text-base font-medium text-ink">
                  {formatARS(li.item.price.amount * li.quantity)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Dates */}
      <section className="flex flex-col gap-1">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm text-ink-soft">Creado</span>
          <time dateTime={detail.createdAt} className="text-sm text-ink">
            {formatDate(detail.createdAt)}
          </time>
        </div>
        {detail.confirmedAt && (
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm text-ink-soft">Pagado</span>
            <time dateTime={detail.confirmedAt} className="text-sm text-ink">
              {formatDate(detail.confirmedAt)}
            </time>
          </div>
        )}
      </section>

      {/* HOP 2: forward-navigate to comprobante+envío only when the cobro is confirmed */}
      {detail.estado === "confirmed" && (
        <>
          <SecondaryButton onClick={onViewReceipt}>Ver comprobante y envío</SecondaryButton>
          {navErr && <p className="text-sm text-danger-ink">{navErr}</p>}
        </>
      )}

      {/* GAP 3: pending state — copy checkout link when available.
          permalink_url is set by toCobroUCPOrder from CobroDetail.checkoutUrl
          (cobro-status-render.ts line 63). Present only when a real MP checkout
          link was generated; null/undefined when MP was not connected. */}
      {detail.estado === "pending" && detail.ucp.permalink_url && (
        <CopyLinkButton url={detail.ucp.permalink_url} />
      )}
    </main>
  );
}

/**
 * Clipboard copy button for the pending-state checkout link.
 * Mirrors the payment-link-wizard "Copiar link" pattern (same 2s feedback, same SecondaryButton).
 * Only rendered when permalink_url is non-null (guarded by caller).
 */
function CopyLinkButton({ url }: { url: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  async function onCopy() {
    try { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* blocked */ }
  }
  return <SecondaryButton onClick={onCopy}>{copied ? "¡Copiado!" : "Copiar link de pago"}</SecondaryButton>;
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

const rootEl = document.getElementById("root");
if (rootEl) createRoot(rootEl).render(<CobroStatusWidget />);
