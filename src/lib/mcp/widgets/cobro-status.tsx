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

import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { useApp, useHostStyleVariables, useHostFonts } from "@modelcontextprotocol/ext-apps/react";
import type { UCPOrder, UCPTotal } from "../_lib/ucp-types";
import { Card, SecondaryButton, Centered, InlineSkeleton, ReturnHint, SupersededNotice, TONE_CLASSES, type StatusTone } from "./_widget-primitives";

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
  /** Server-assigned render timestamp (epoch ms), used ONLY as the widget
   * instance-supersession election key (claude.com/docs/connectors/building/
   * mcp-apps/instance-supersession) — NOT a business date. Optional because
   * cobro-status-render.ts does not emit it yet; guarded with Number.isFinite
   * below so an unpatched server degrades to "no supersession" instead of
   * crashing. */
  createdAt?: number;
  /** Monotonic per-process tie-breaker for createdAt collisions (same-ms calls,
   * routine under rapid reopens) — claude.com/docs/connectors/building/mcp-apps/
   * instance-supersession#run-the-election-in-the-widget. Optional for the same
   * unpatched-server-degrades-gracefully reason as createdAt. */
  seq?: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Total amount from UCP totals array (type="total"). Falls back to first total. */
function resolveTotal(totals: UCPTotal[]): number {
  const t = totals.find((x) => x.type === "total") ?? totals[0];
  return t ? t.amount : 0;
}

// Same cap convention as pending-orders.tsx's DISPLAY_CAP.
const LINE_ITEMS_CAP = 10;

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
// Tone + label per estado — colors resolve through widget.css's shared
// success/danger tokens (StatusTone in _widget-primitives), not one-off
// light-dark() inline styles.

interface ChipConfig {
  label: string;
  tone: StatusTone;
}

function resolveChipConfig(estado: CobroEstado): ChipConfig {
  switch (estado) {
    case "confirmed":
      return { label: "Pagado ✓", tone: "success" };
    case "pending":
      return { label: "Esperando pago", tone: "pending" };
    case "expired":
      return { label: "Vencido", tone: "danger" };
    case "cancelled":
      return { label: "Cancelado", tone: "danger" };
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
  const [superseded, setSuperseded] = useState(false);

  // Widget instance supersession (claude.com/docs/connectors/building/mcp-apps/
  // instance-supersession) — cobro-status is a status view the owner can
  // reasonably re-open mid-conversation to re-check whether a payment came in
  // (e.g. asking "¿ya pagó Juan?" twice). Only the newest copy should stay
  // interactive; older copies gray out instead of both silently feeding stale
  // reads back into Claude's context. Channel is scoped per-conversation by
  // default (no fixed _meta.ui.domain set on this resource).
  const instanceIdRef = useRef<string>(crypto.randomUUID());
  const orderKeyRef = useRef<number | undefined>(undefined);
  const seqRef = useRef<number | undefined>(undefined);
  const keyFinalizedRef = useRef(false);
  const channelRef = useRef<BroadcastChannel | null>(null);
  const peersRef = useRef(new Map<string, { orderKey: number; seq?: number; instanceId: string }>());

  useEffect(() => {
    const channel = new BroadcastChannel("velora-cobro-status-supersede");
    channelRef.current = channel;
    const instanceId = instanceIdRef.current;

    // seq tie-breaks createdAt ties (same-ms calls) before falling back to
    // instanceId — claude.com/docs/connectors/building/mcp-apps/instance-supersession.
    function isYounger(other: { orderKey: number; seq?: number; instanceId: string }) {
      if (!keyFinalizedRef.current || orderKeyRef.current == null) return false;
      if (other.orderKey !== orderKeyRef.current) return other.orderKey > orderKeyRef.current!;
      if (other.seq != null && seqRef.current != null && other.seq !== seqRef.current) return other.seq > seqRef.current;
      return other.instanceId > instanceId;
    }

    channel.onmessage = (ev) => {
      const msg = ev.data as { type?: string; instanceId?: string; orderKey?: number; seq?: number } | undefined;
      if (!msg?.instanceId || msg.instanceId === instanceId || !keyFinalizedRef.current) return;
      if (msg.type === "hello") {
        channel.postMessage({ type: "born", instanceId, orderKey: orderKeyRef.current, seq: seqRef.current });
      }
      if (Number.isFinite(msg.orderKey)) {
        peersRef.current.set(msg.instanceId, { orderKey: msg.orderKey!, seq: msg.seq, instanceId: msg.instanceId });
        setSuperseded([...peersRef.current.values()].some(isYounger));
      }
    };

    return () => channel.close();
  }, []);

  function announceInstance() {
    const channel = channelRef.current;
    if (!channel || orderKeyRef.current == null) return;
    const instanceId = instanceIdRef.current;
    channel.postMessage({ type: "hello", instanceId, orderKey: orderKeyRef.current, seq: seqRef.current });
    channel.postMessage({ type: "born", instanceId, orderKey: orderKeyRef.current, seq: seqRef.current });
  }

  useEffect(() => {
    if (!app) return;
    // Render data arrives ONLY via ontoolresult (ui/notifications/tool-result → structuredContent).
    // ontoolinput is intentionally NOT wired: it carries the tool INPUT args (no resolved fields) and would flash NaN/undefined.
    const apply = (params: { structuredContent?: unknown; arguments?: unknown }) => {
      const raw = (params.structuredContent ?? params.arguments ?? {}) as { prefill?: Prefill } & Prefill;
      const args = (raw.prefill ?? raw) as Prefill;
      setOrder(args.order ?? null);
      setLoaded(true);
      if (Number.isFinite(args.createdAt)) {
        orderKeyRef.current = args.createdAt;
        seqRef.current = Number.isFinite(args.seq) ? args.seq : undefined;
        keyFinalizedRef.current = true;
        announceInstance();
      }
    };
    app.ontoolresult = (params) => apply(params);
  }, [app]);

  // Chaining into a DIFFERENT widget via a direct callServerTool from inside
  // this one was live-confirmed to succeed server-side but never render a
  // new widget (docs/TODO-widget-initiated-tool-call-no-render.md). Prefer
  // app.sendMessage so Claude processes it as a real turn and calls the tool
  // itself — confirmed working live 2026-07-27 for the same pattern in
  // catalog-selector.tsx. Falls back to the direct call on hosts without the
  // `message` capability. Uses customerName (not paymentIntentId) since
  // that's what a typed message can carry naturally — open_delivery_receipt
  // already resolves by customerName (most-recent confirmed cobro).
  const onViewReceipt = useCallback(async () => {
    if (!app || !order || superseded) return;
    setNavErr(null);
    if (app.getHostCapabilities()?.message) {
      await app.sendMessage({
        role: "user",
        content: [{ type: "text", text: `Mostrame el comprobante y envío del cobro de ${order.customerName}.` }],
      }).catch(() => setNavErr("No se pudo abrir el comprobante. Intentá de nuevo."));
      return;
    }
    await app.callServerTool({ name: "open_delivery_receipt", arguments: { paymentIntentId: order.ucp.id } }).catch(() => {
      setNavErr("No se pudo abrir el comprobante. Intentá de nuevo.");
    });
  }, [app, order, superseded]);

  if (error) {
    return <Centered>No pudimos abrir el estado del cobro. {error.message}</Centered>;
  }
  if (!isConnected) return <Centered>Conectando…</Centered>;
  if (!loaded) return <InlineSkeleton rows={3} label="Cargando estado del cobro" />;
  if (order === null) {
    return <Centered>No encontré ese cobro.</Centered>;
  }

  // TypeScript: order is DisplayOrder here — both `null` and !loaded are guarded above.
  const detail: DisplayOrder = order;
  const total = resolveTotal(detail.ucp.totals);
  const chip = resolveChipConfig(detail.estado);

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
    <Card title="Estado del cobro" style={safeAreaStyle}>
      {superseded ? <SupersededNotice /> : <ReturnHint />}
      {/* BIG status banner */}
      <section
        aria-label="Estado del cobro"
        className={`flex items-center justify-center rounded-control px-4 py-3 text-lg font-semibold ${TONE_CLASSES[chip.tone]}`}
      >
        {chip.label}
      </section>

      {/* Customer + total */}
      <section className="flex flex-col gap-1 rounded-control bg-surface-2 px-4 py-3">
        <span className="text-base font-medium text-ink">{detail.customerName}</span>
        <span className="text-xl font-bold tabular-nums text-ink">{formatARS(total)}</span>
      </section>

      {/* Line items — capped per pending-orders.tsx's DISPLAY_CAP convention.
       * JD finding (2026-07-26): the host clips inline content that exceeds its
       * height, it doesn't scroll it — an uncapped list here could push the
       * action button below the clip line on any order with a few items. */}
      {detail.ucp.line_items.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-medium text-ink-soft">Productos</h2>
          <ul className="flex flex-col gap-2">
            {detail.ucp.line_items.slice(0, LINE_ITEMS_CAP).map((li) => (
              <li
                key={li.id}
                className="flex items-center justify-between gap-2 rounded-control bg-surface-2 px-4 py-3"
              >
                <span className="text-base text-ink">
                  {li.quantity}× {li.item.title}
                </span>
                <span className="shrink-0 text-base font-medium tabular-nums text-ink">
                  {formatARS(li.item.price.amount * li.quantity)}
                </span>
              </li>
            ))}
          </ul>
          {detail.ucp.line_items.length > LINE_ITEMS_CAP && (
            <p className="mt-2 text-sm text-ink-soft">
              y {detail.ucp.line_items.length - LINE_ITEMS_CAP} producto{detail.ucp.line_items.length - LINE_ITEMS_CAP !== 1 ? "s" : ""} más
            </p>
          )}
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
    </Card>
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
