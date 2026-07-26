// sale-confirm.tsx — MCP App widget for cash-sale preview + confirmation.
//
// MONEY PATH (NABAOS): the displayed prices and total are resolved from the
// catalog by the render tool (open_sale_confirm) — never from typed amounts.
// The widget fires register_sale via callServerTool; register_sale recomputes
// the authoritative price from the catalog server-side, owns idempotency and
// all audit/inventory guards.
//
// Pattern: preview→confirm (same safe pattern as payment-link-wizard).
// No-customer path: customerId may be empty (consumidor final) — register_sale
// allows anonymous sales; no confirm block is applied here.
//
// Design principles (industry-sourced, HTTP 200 verified):
//   - One primary action, no nested scroll — OpenAI Apps SDK UI guidelines
//     (developers.openai.com/apps-sdk/concepts/ui-guidelines).
//   - Native semantic elements: <main>, <ul>, <li> (W3C First Rule of ARIA).
//   - Chameleon theming: Tailwind v4 mapped to host CSS variables via
//     ext-apps useHostStyleVariables/useHostFonts.
//   - Typography: rem units, ≥ 0.875rem (14px) minimum per 2026 standards.
//
// Data contract: structuredContent.prefill from open_sale_confirm tool.
//   { items: [{productId, quantity, name, unitPrice}], customerId, customerName, totalARS }
//
// CSP: no allowUnsafeEval — do NOT add it without a CSP audit.

import React, { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { useApp, useHostStyleVariables, useHostFonts } from "@modelcontextprotocol/ext-apps/react";
import { Card, Field, PrimaryButton, Centered } from "./_widget-primitives";

// Same cap convention as pending-orders.tsx's DISPLAY_CAP — the host clips
// (doesn't scroll) inline content past its height, so an uncapped item list
// can push "Total a cobrar" and the confirm button off-screen (JD, 2026-07-26).
const LINE_ITEMS_CAP = 10;

// ── Types ─────────────────────────────────────────────────────────────────────

interface PrefillItem {
  productId: string;
  quantity: number;
  name: string;
  unitPrice: number;
}

interface Prefill {
  items: PrefillItem[];
  customerId: string;
  customerName: string;
  totalARS: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const ars = (n: number) =>
  Number.isFinite(n)
    ? "$ " + n.toLocaleString("es-AR", { minimumFractionDigits: 0, maximumFractionDigits: 2 })
    : "—";

// ── Main widget ───────────────────────────────────────────────────────────────

function SaleConfirmWidget(): React.JSX.Element {
  const { app, isConnected, error } = useApp({
    appInfo: { name: "sale-confirm", version: "1.0.0" },
    capabilities: {},
  });
  useHostStyleVariables(app, app?.getHostContext());
  useHostFonts(app, app?.getHostContext());

  const [prefill, setPrefill] = useState<Prefill | null>(null);
  const [toolResultReceived, setToolResultReceived] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [saleId, setSaleId] = useState<string | null>(null);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!app) return;
    // Render data arrives ONLY via ontoolresult (ui/notifications/tool-result → structuredContent).
    // ontoolinput is intentionally NOT wired: it carries the tool INPUT args (no resolved fields)
    // and would flash unresolved product names/prices.
    const apply = (params: { structuredContent?: unknown; arguments?: unknown }) => {
      setToolResultReceived(true);
      const raw = (params.structuredContent ?? params.arguments ?? {}) as { prefill?: Prefill } & Prefill;
      const args = (raw.prefill ?? raw) as Prefill;
      setPrefill(args);
    };
    app.ontoolresult = (params) => apply(params);
  }, [app]);

  const onConfirm = useCallback(async () => {
    if (!app || !prefill) return;
    setSubmitting(true);
    setErrMsg(null);
    try {
      const result = await app.callServerTool({
        name: "register_sale",
        arguments: {
          items: prefill.items.map((it) => ({
            productId: it.productId,
            quantity: it.quantity,
            // unitPrice is intentionally omitted — register_sale uses catalog price as authoritative.
          })),
          ...(prefill.customerId ? { customerId: prefill.customerId } : {}),
          paymentMethod: "efectivo",
        },
      });
      if (result.isError) {
        const raw = (result.content?.[0] as { text?: string } | undefined)?.text ?? "{}";
        let message = "No se pudo registrar la venta. Intentá de nuevo.";
        try {
          const p = JSON.parse(raw) as { message?: string; code?: string };
          message = p.message ?? message;
        } catch { /* defaults */ }
        setErrMsg(message);
        return;
      }
      // Extract saleId from result for confirmation display.
      const sc = result.structuredContent as { saleId?: string } | undefined;
      const raw = (result.content?.[0] as { text?: string } | undefined)?.text ?? "{}";
      let resolvedSaleId: string | null = sc?.saleId ?? null;
      if (!resolvedSaleId) {
        try {
          const p = JSON.parse(raw) as { saleId?: string };
          resolvedSaleId = p.saleId ?? null;
        } catch { /* no saleId */ }
      }
      setSaleId(resolvedSaleId);
      setConfirmed(true);
    } catch {
      setErrMsg("No se pudo registrar la venta. Intentá de nuevo.");
    } finally {
      setSubmitting(false);
    }
  }, [app, prefill]);

  // ── Loading / error states ────────────────────────────────────────────────

  if (error) return <Centered>No pudimos abrir la confirmación de venta. {error.message}</Centered>;
  if (!isConnected) return <Centered>Conectando…</Centered>;
  if (!prefill && toolResultReceived)
    return <Centered>No pudimos cargar los datos de la venta. Probá de nuevo.</Centered>;
  if (!prefill) return <Centered>Esperando los datos de la venta…</Centered>;

  // Safe areas (claude.com/docs/connectors/building/mcp-apps/design-guidelines
  // #host-context-for-layout): on mobile the chat composer/nav bar can overlay
  // this widget's edges. hostContext.safeAreaInsets is in pixels — add it on
  // top of the base padding rather than replacing it.
  const safeArea = app?.getHostContext()?.safeAreaInsets;
  const safeAreaStyle: React.CSSProperties = safeArea
    ? {
        paddingTop: `calc(1.25rem + ${safeArea.top}px)`,
        paddingRight: `calc(1.25rem + ${safeArea.right}px)`,
        paddingBottom: `calc(1.25rem + ${safeArea.bottom}px)`,
        paddingLeft: `calc(1.25rem + ${safeArea.left}px)`,
      }
    : {};

  // ── Confirmation screen ───────────────────────────────────────────────────

  if (confirmed) {
    return (
      <Card title="Venta registrada ✓" style={safeAreaStyle}>
        <p className="text-base text-ink-soft">
          {prefill.customerName !== "Consumidor final"
            ? `Venta para ${prefill.customerName} registrada correctamente.`
            : "Venta registrada correctamente."}
        </p>
        <div className="flex items-center justify-between rounded-control bg-success-surface px-4 py-3 text-success-ink">
          <span className="text-base font-medium">Total cobrado</span>
          <span className="text-xl font-bold tabular-nums">{ars(prefill.totalARS)}</span>
        </div>
        {saleId && (
          <p className="text-sm text-ink-soft">ID de venta: {saleId}</p>
        )}
      </Card>
    );
  }

  // ── Empty items guard ─────────────────────────────────────────────────────

  if (prefill.items.length === 0) {
    return <Centered>No se cargaron productos para esta venta. Probá de nuevo desde Velora.</Centered>;
  }

  // ── Preview screen ────────────────────────────────────────────────────────

  return (
    <Card title="Confirmar venta" style={safeAreaStyle}>
      {/* Customer */}
      <Field label="Cliente">
        <span className="text-base font-medium text-ink">{prefill.customerName}</span>
      </Field>

      {/* Line items — capped (see LINE_ITEMS_CAP above). */}
      <div>
        <div className="mb-1 text-sm text-ink-soft">Productos</div>
        <ul className="flex flex-col gap-2">
          {prefill.items.slice(0, LINE_ITEMS_CAP).map((it) => (
            <li
              key={it.productId}
              className="flex items-center justify-between gap-3 rounded-control bg-surface-2 p-3"
            >
              <div className="min-w-0">
                <div className="truncate text-base text-ink">{it.name}</div>
                <div className="text-sm tabular-nums text-ink-soft">
                  {ars(it.unitPrice)} c/u
                </div>
              </div>
              <div className="shrink-0 text-right">
                <div className="text-base font-medium tabular-nums text-ink">{ars(it.quantity * it.unitPrice)}</div>
                <div className="text-sm text-ink-soft">× {it.quantity}</div>
              </div>
            </li>
          ))}
        </ul>
        {prefill.items.length > LINE_ITEMS_CAP && (
          <p className="mt-2 text-sm text-ink-soft">
            y {prefill.items.length - LINE_ITEMS_CAP} producto{prefill.items.length - LINE_ITEMS_CAP !== 1 ? "s" : ""} más
          </p>
        )}
      </div>

      {/* Total */}
      <Field label="Total a cobrar">
        <span className="text-3xl font-bold leading-tight tabular-nums text-ink">{ars(prefill.totalARS)}</span>
      </Field>

      <p className="text-sm text-ink-soft">
        Método de pago: efectivo. El total se calcula con los precios del catálogo.
      </p>

      {/* JD finding (2026-07-26): this screen fires a real register_sale mutation
       * with zero guardrail on a $0 total — far more likely a forgotten price than
       * an intentional freebie. Block confirm and say why, instead of registering
       * a free sale silently. */}
      {prefill.totalARS <= 0 && (
        <div className="rounded-control bg-danger-surface p-3 text-sm text-danger-ink" role="alert">
          El total es $0 — revisá los precios del catálogo antes de confirmar.
        </div>
      )}

      {errMsg && (
        <div className="rounded-control bg-danger-surface p-3 text-sm text-danger-ink" role="alert">
          {errMsg}
        </div>
      )}

      <PrimaryButton disabled={submitting || prefill.totalARS <= 0} onClick={onConfirm}>
        {submitting ? "Registrando…" : "Confirmar venta"}
      </PrimaryButton>
    </Card>
  );
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

const rootEl = document.getElementById("root");
if (rootEl) createRoot(rootEl).render(<SaleConfirmWidget />);
