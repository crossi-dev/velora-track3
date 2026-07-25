// pending-orders.tsx — MCP App widget for the owner's pending cobros dashboard.
//
// READ-ONLY — this widget never calls a money-mutating tool.
// It displays a list of PaymentIntents with estado="pending", each card showing:
//   - customer name
//   - compact items summary ("3× Alfajor, 2× Agua")
//   - total in ARS (es-AR locale)
//   - status chip "Esperando pago"
//   - creation date (es-AR short)
//   - "Ver estado" button → open_cobro_status (hop 1 of the commerce chain)
//
// Design principles (industry-sourced, HTTP 200 verified):
//   - Card list, auto-fit per OpenAI Apps SDK UI guidelines
//     (developers.openai.com/apps-sdk/concepts/ui-guidelines).
//   - Native semantic elements: <main>, <ul>, <li>, <time> (W3C First Rule of ARIA).
//   - Chameleon theming: Tailwind v4 mapped to host CSS variables via
//     ext-apps useHostStyleVariables/useHostFonts.
//   - Typography: rem units, ≥ 0.875 rem (14 px) minimum per 2026 standards.
//   - Safe areas (claude.com/docs/connectors/building/mcp-apps/design-guidelines
//     #host-context-for-layout): on mobile the chat composer/nav bar can overlay
//     this widget's edges. hostContext.safeAreaInsets is in pixels — add it on
//     top of the base p-5 padding rather than replacing it.
//   - Widget instance supersession (claude.com/docs/connectors/building/mcp-apps/
//     instance-supersession) — this is a dashboard list the owner can reasonably
//     re-open mid-conversation ("mostrame los cobros pendientes de nuevo"), the
//     doc's textbook case: if the owner re-asks, only the newest copy of this
//     widget should stay interactive. Older copies gray out and stop navigating
//     instead of silently feeding stale reads back into Claude's context.
//
// Data contract: structuredContent.prefill.orders from open_pending_orders tool.
// Each item is { ucp: UCPOrder, customerName: string, createdAt: string, status: "pending" }.
// ucp.id is the PaymentIntent id accepted by open_cobro_status (verified: pending-orders-render.ts
// toUCPOrder() sets id: po.id which is PendingOrder.id = PaymentIntent.id).
//
// UCP Order spec: https://ucp.dev/latest/specification/order/
// CSP: no allowUnsafeEval — do NOT add it without a CSP audit.

import React, { useCallback, useEffect, useState, useRef } from "react";
import { createRoot } from "react-dom/client";
import { useApp, useHostStyleVariables, useHostFonts } from "@modelcontextprotocol/ext-apps/react";
import type { UCPOrder, UCPLineItem, UCPTotal } from "../_lib/ucp-types";
import { Centered, SecondaryButton, StatusChip } from "./_widget-primitives";

// ── Velora display extension (not UCP fields) ─────────────────────────────────
// UCP Order has no buyer/created_at fields. Velora carries them alongside.

interface DisplayOrder {
  ucp: UCPOrder;
  customerName: string;
  createdAt: string;  // ISO date string
  status: "pending";
}

interface Prefill {
  orders: DisplayOrder[];
  /** Top-level election key for widget-instance supersession (server wall-clock
   * ms at prefill time) — same pattern as business-overview-render.ts's
   * top-level `createdAt`. Optional purely for defensive typing (Number.isFinite
   * guard in ontoolresult below); pending-orders-render.ts always sets it. */
  createdAt?: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Compact summary of line items: "3× Alfajor, 2× Agua mineral" (capped at 3). */
function itemsSummary(lineItems: UCPLineItem[]): string {
  if (lineItems.length === 0) return "Sin productos";
  const shown = lineItems.slice(0, 3);
  const rest = lineItems.length - shown.length;
  const parts = shown.map((li) => `${li.quantity}× ${li.item.title}`);
  if (rest > 0) parts.push(`y ${rest} más`);
  return parts.join(", ");
}

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

const DISPLAY_CAP = 10;

// ── Main widget ───────────────────────────────────────────────────────────────

function PendingOrdersList(): React.JSX.Element {
  const { app, isConnected, error } = useApp({
    appInfo: { name: "pending-orders", version: "1.0.0" },
    capabilities: {},
  });
  useHostStyleVariables(app, app?.getHostContext());
  useHostFonts(app, app?.getHostContext());

  const [orders, setOrders] = useState<DisplayOrder[]>([]);
  const [loaded, setLoaded] = useState(false);
  // Per-card nav error: keyed by paymentIntentId (ucp.id).
  const [navErrors, setNavErrors] = useState<Record<string, string>>({});
  const [superseded, setSuperseded] = useState(false);

  // Widget instance supersession (claude.com/docs/connectors/building/mcp-apps/
  // instance-supersession) — this dashboard is exactly the doc's textbook case:
  // if the owner re-asks "mostrame los cobros pendientes de nuevo" mid-conversation,
  // only the newest copy of this widget should stay interactive. Older copies gray
  // out instead of both silently feeding stale reads back into Claude's context.
  // Channel is scoped per-conversation by default (no fixed _meta.ui.domain set on
  // this resource).
  const instanceIdRef = useRef<string>(crypto.randomUUID());
  const orderKeyRef = useRef<number | undefined>(undefined);
  const keyFinalizedRef = useRef(false);
  const channelRef = useRef<BroadcastChannel | null>(null);
  const peersRef = useRef(new Map<string, { orderKey: number; instanceId: string }>());

  useEffect(() => {
    const channel = new BroadcastChannel("velora-pending-orders-supersede");
    channelRef.current = channel;
    const instanceId = instanceIdRef.current;

    function isYounger(other: { orderKey: number; instanceId: string }) {
      if (!keyFinalizedRef.current || orderKeyRef.current == null) return false;
      if (other.orderKey !== orderKeyRef.current) return other.orderKey > orderKeyRef.current!;
      return other.instanceId > instanceId;
    }

    channel.onmessage = (ev) => {
      const msg = ev.data as { type?: string; instanceId?: string; orderKey?: number } | undefined;
      if (!msg?.instanceId || msg.instanceId === instanceId || !keyFinalizedRef.current) return;
      if (msg.type === "hello") {
        channel.postMessage({ type: "born", instanceId, orderKey: orderKeyRef.current });
      }
      if (Number.isFinite(msg.orderKey)) {
        peersRef.current.set(msg.instanceId, { orderKey: msg.orderKey!, instanceId: msg.instanceId });
        setSuperseded([...peersRef.current.values()].some(isYounger));
      }
    };

    return () => channel.close();
  }, []);

  function announceInstance() {
    const channel = channelRef.current;
    if (!channel || orderKeyRef.current == null) return;
    const instanceId = instanceIdRef.current;
    channel.postMessage({ type: "hello", instanceId, orderKey: orderKeyRef.current });
    channel.postMessage({ type: "born", instanceId, orderKey: orderKeyRef.current });
  }

  useEffect(() => {
    if (!app) return;
    // Render data arrives ONLY via ontoolresult (ui/notifications/tool-result → structuredContent).
    // ontoolinput is intentionally NOT wired: it carries the tool INPUT args (no resolved fields) and would flash NaN/undefined.
    const apply = (params: { structuredContent?: unknown; arguments?: unknown }) => {
      const raw = (params.structuredContent ?? params.arguments ?? {}) as { prefill?: Prefill } & Prefill;
      const args = (raw.prefill ?? raw) as Prefill;
      setOrders(args.orders ?? []);
      setLoaded(true);
      if (Number.isFinite(args.createdAt)) {
        orderKeyRef.current = args.createdAt;
        keyFinalizedRef.current = true;
        announceInstance();
      }
    };
    app.ontoolresult = (params) => apply(params);
  }, [app]);

  // HOP: pending-orders → cobro-status (verified: ucp.id = PaymentIntent id,
  // open_cobro_status accepts paymentIntentId — cobro-status-render.ts inputSchema).
  const onViewStatus = useCallback(async (paymentIntentId: string) => {
    if (!app || superseded) return;
    setNavErrors((prev) => ({ ...prev, [paymentIntentId]: "" }));
    await app.callServerTool({ name: "open_cobro_status", arguments: { paymentIntentId } }).catch(() => {
      setNavErrors((prev) => ({ ...prev, [paymentIntentId]: "No se pudo abrir el estado. Intentá de nuevo." }));
    });
  }, [app, superseded]);

  if (error) {
    return <Centered>No pudimos abrir el panel de cobros. {error.message}</Centered>;
  }
  if (!isConnected) return <Centered>Conectando…</Centered>;
  if (!loaded) return <Centered>Cargando cobros pendientes…</Centered>;

  const displayed = orders.slice(0, DISPLAY_CAP);
  const overflow = orders.length - displayed.length;

  // Safe areas (claude.com/docs/connectors/building/mcp-apps/design-guidelines
  // #host-context-for-layout): on mobile the chat composer/nav bar can overlay
  // this widget's edges. hostContext.safeAreaInsets is in pixels — add it on
  // top of the base p-5 padding rather than replacing it.
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
    <main className="mx-auto flex max-w-md flex-col gap-4 p-5 text-ink" style={safeAreaStyle}>
      {superseded && (
        <div className="flex items-center justify-between gap-2 rounded-control bg-surface-2 p-3 text-sm text-ink-soft" role="status">
          <span>Esta vista quedó vieja — hay una más nueva en este chat.</span>
        </div>
      )}
      <h1 className="text-xl font-semibold leading-snug">Cobros pendientes</h1>

      {displayed.length === 0 ? (
        <p className="rounded-control bg-surface-2 p-4 text-base text-ink-soft">
          No hay cobros pendientes.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {displayed.map((order) => {
            const total = resolveTotal(order.ucp.totals);
            const navErr = navErrors[order.ucp.id];
            return (
              <li
                key={order.ucp.id}
                className="flex flex-col gap-2 rounded-control bg-surface-2 p-4"
              >
                {/* Customer + date row */}
                <div className="flex items-start justify-between gap-2">
                  <span className="text-base font-medium text-ink">{order.customerName}</span>
                  <time
                    dateTime={order.createdAt}
                    className="shrink-0 text-sm text-ink-soft"
                  >
                    {formatDate(order.createdAt)}
                  </time>
                </div>

                {/* Items summary */}
                <p className="text-sm text-ink-soft">
                  {itemsSummary(order.ucp.line_items)}
                </p>

                {/* Total + status chip row */}
                <div className="flex items-center justify-between gap-2">
                  <span className="text-base font-semibold tabular-nums text-ink">
                    {formatARS(total)}
                  </span>
                  <span aria-label="Estado del cobro">
                    <StatusChip tone="pending">Esperando pago</StatusChip>
                  </span>
                </div>

                {/* HOP: → cobro-status */}
                <SecondaryButton onClick={() => onViewStatus(order.ucp.id)}>Ver estado</SecondaryButton>
                {navErr && <p className="text-sm text-danger-ink">{navErr}</p>}
              </li>
            );
          })}
        </ul>
      )}

      {overflow > 0 && (
        <p className="text-sm text-ink-soft">
          y {overflow} cobro{overflow !== 1 ? "s" : ""} más
        </p>
      )}
    </main>
  );
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

const rootEl = document.getElementById("root");
if (rootEl) createRoot(rootEl).render(<PendingOrdersList />);
