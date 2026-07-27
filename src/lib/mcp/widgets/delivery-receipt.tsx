// delivery-receipt.tsx — MCP App widget: comprobante + envío (step 5, commerce flow).
//
// READ-ONLY — this widget never calls a money-mutating tool.
// Shows, for a confirmed cobro: the comprobante/factura block (AFIP-flexible),
// the line items + total (ARS), and the envío status (carrier + tracking, or
// "Retiro en local — sin envío" when no shipment was created).
//
// Design principles (industry-sourced):
//   - Full-bleed status sections per Material Design 3 chip guidelines (m3.material.io).
//   - Native semantic elements: <main>, <section>, <ul>, <li> (W3C First Rule of ARIA).
//   - Chameleon theming: Tailwind v4 mapped to host CSS variables via useHostStyleVariables/useHostFonts.
//   - Typography: rem units, ≥ 0.875rem (14px) minimum per 2026 WCAG 2.2 AA standards.
//   - No Zod, no eval — all data from structuredContent.prefill.order.
//
// Data contract: structuredContent.prefill.order from open_delivery_receipt tool.
//   order is { ucp, customerName, comprobante, envio, estado } or null (not found).
//   ucp follows UCP Order spec (ucp.dev/latest/specification/order/).
//   comprobante + envio are Velora display extensions.
//
// UCP Order spec: https://ucp.dev/latest/specification/order/
// CSP: no allowUnsafeEval — do NOT add it.

import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { useApp, useHostStyleVariables, useHostFonts } from "@modelcontextprotocol/ext-apps/react";
import { Card, SecondaryButton, Centered, ReturnHint, SupersededNotice, StatusChip, type StatusTone } from "./_widget-primitives";
import type { UCPOrder, UCPTotal } from "../_lib/ucp-types";

// ── Velora display extensions ─────────────────────────────────────────────────

interface DeliveryComprobante {
  kind: "factura" | "comprobante";
  label: string;
  number?: string;
  pdfUrl?: string;
}

interface DeliveryEnvio {
  carrier: string;
  tracking?: string;
  status: string;
}

interface DisplayOrder {
  ucp: UCPOrder;
  customerName: string;
  /** Customer phone (E.164 or raw) populated from Customer.phone. Null when not on record. */
  customerPhone?: string | null;
  comprobante: DeliveryComprobante;
  envio: DeliveryEnvio | null;
  estado: string;
}

interface Prefill {
  order: DisplayOrder | null;
  /** Election key for widget instance supersession (claude.com/docs/connectors/
   * building/mcp-apps/instance-supersession) — see delivery-receipt-render.ts.
   * Optional until the render tool is updated to always set it (server-side
   * dependency; flagged separately); guarded with Number.isFinite below so an
   * unpatched server degrades to "no supersession" instead of crashing. */
  createdAt?: number;
  /** Monotonic per-process tie-breaker for createdAt collisions (same-ms calls) —
   * claude.com/docs/connectors/building/mcp-apps/instance-supersession. */
  seq?: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function resolveTotal(totals: UCPTotal[]): number {
  const t = totals.find((x) => x.type === "total") ?? totals[0];
  return t ? t.amount : 0;
}

// Same cap convention as pending-orders.tsx's DISPLAY_CAP.
const LINE_ITEMS_CAP = 10;

function formatARS(minorUnits: number): string {
  const pesos = minorUnits / 100;
  return "$ " + pesos.toLocaleString("es-AR", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

// ── Envío status chip configuration ──────────────────────────────────────────
// Tone + label per status — colors resolve through widget.css's shared
// success/danger tokens (StatusTone in _widget-primitives), not one-off
// light-dark() inline styles.

interface ChipConfig {
  label: string;
  tone: StatusTone;
}

function resolveEnvioChip(status: string): ChipConfig {
  switch (status) {
    case "delivered":
      return { label: "Entregado ✓", tone: "success" };
    case "in_transit":
      return { label: "En tránsito", tone: "pending" };
    case "failed":
      return { label: "Problema en envío", tone: "danger" };
    default: // "created" and others
      return { label: "Envío creado", tone: "pending" };
  }
}

// ── Main widget ───────────────────────────────────────────────────────────────

function DeliveryReceiptWidget(): React.JSX.Element {
  const { app, isConnected, error } = useApp({
    appInfo: { name: "delivery-receipt", version: "1.0.0" },
    capabilities: {},
  });
  useHostStyleVariables(app, app?.getHostContext());
  useHostFonts(app, app?.getHostContext());

  const [order, setOrder] = useState<DisplayOrder | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [sendingWa, setSendingWa] = useState(false);
  const [waSentMsg, setWaSentMsg] = useState<string | null>(null);
  const [superseded, setSuperseded] = useState(false);

  // Widget instance supersession (claude.com/docs/connectors/building/mcp-apps/
  // instance-supersession) — this widget fires a real mutating action
  // (send_whatsapp_text via onSendComprobante). If the owner re-asks "mandame
  // el comprobante de Juan" mid-conversation, only the newest copy should stay
  // interactive — an older copy must not also fire the WhatsApp send. Same
  // election pattern as cobro-status.tsx. Channel is scoped per-conversation by
  // default (no fixed _meta.ui.domain set on this resource).
  const instanceIdRef = useRef<string>(crypto.randomUUID());
  const orderKeyRef = useRef<number | undefined>(undefined);
  const seqRef = useRef<number | undefined>(undefined);
  const keyFinalizedRef = useRef(false);
  const channelRef = useRef<BroadcastChannel | null>(null);
  const peersRef = useRef(new Map<string, { orderKey: number; seq?: number; instanceId: string }>());

  useEffect(() => {
    const channel = new BroadcastChannel("velora-delivery-receipt-supersede");
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
        keyFinalizedRef.current = true;
        announceInstance();
      }
    };
    app.ontoolresult = (params) => apply(params);
  }, [app]);

  async function onSendComprobante(phone: string, pdfUrl: string) {
    if (!app || superseded) return;
    setSendingWa(true);
    setWaSentMsg(null);
    try {
      // send_whatsapp_text: fields are `to` (phone), `text` (message body), optional `mediaUrl`.
      // pdfUrl is the AFIP fiscal QR URL (not a downloadable PDF), so we include it in the text
      // body rather than as mediaUrl (mediaUrl requires a directly downloadable media file).
      const message = `¡Hola! Te mandamos el comprobante de tu compra. Ver comprobante AFIP: ${pdfUrl}`;
      const result = await app.callServerTool({
        name: "send_whatsapp_text",
        arguments: { to: phone, text: message },
      });
      if (result.isError) {
        const raw = (result.content?.[0] as { text?: string } | undefined)?.text ?? "{}";
        let msg = "No se pudo enviar el comprobante.";
        try { const p = JSON.parse(raw) as { message?: string }; msg = p.message ?? msg; } catch { /* default */ }
        setWaSentMsg(msg);
      } else {
        setWaSentMsg("Comprobante enviado por WhatsApp.");
      }
    } catch {
      setWaSentMsg("No se pudo enviar el comprobante. Intentá de nuevo.");
    } finally {
      setSendingWa(false);
    }
  }

  if (error) {
    return <Centered>No pudimos abrir el comprobante. {error.message}</Centered>;
  }
  if (!isConnected) return <Centered>Conectando…</Centered>;
  if (!loaded) return <Centered>Cargando comprobante…</Centered>;
  if (order === null) {
    return <Centered>No encontré el comprobante de esta venta.</Centered>;
  }

  const detail: DisplayOrder = order;
  const total = resolveTotal(detail.ucp.totals);
  const { comprobante, envio } = detail;
  // Hoist chip resolution to avoid calling resolveEnvioChip twice in JSX (B#9).
  const envioChip = envio ? resolveEnvioChip(envio.status) : null;
  // Show the WhatsApp send button only when both phone and comprobante pdfUrl are available.
  const canSendWa = !!(detail.customerPhone && comprobante.pdfUrl);

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

  return (
    <Card title="Comprobante y envío" style={safeAreaStyle}>
      {superseded ? <SupersededNotice /> : <ReturnHint />}

      {/* Comprobante block */}
      <section
        aria-label="Comprobante"
        className="flex flex-col gap-1 rounded-control bg-surface-2 px-4 py-3"
      >
        <span className="text-sm font-medium text-ink-soft">
          {comprobante.kind === "factura" ? "Factura electrónica" : "Comprobante de venta"}
        </span>
        <span className="text-base font-semibold text-ink">{comprobante.label}</span>
        {comprobante.number && (
          <span className="text-sm text-ink-soft">N.° {comprobante.number}</span>
        )}
        {comprobante.pdfUrl && (
          <a
            href={comprobante.pdfUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-1 text-sm text-accent underline"
          >
            Ver comprobante AFIP
          </a>
        )}
      </section>

      {/* Customer + total */}
      <section className="flex flex-col gap-1 rounded-control bg-surface-2 px-4 py-3">
        <span className="text-base font-medium text-ink">{detail.customerName}</span>
        <span className="text-xl font-bold tabular-nums text-ink">{formatARS(total)}</span>
      </section>

      {/* Line items — capped per pending-orders.tsx's DISPLAY_CAP convention.
       * JD finding (2026-07-26): the host clips inline content that exceeds its
       * height, it doesn't scroll it — an uncapped list here could push the
       * envío/WhatsApp action below the clip line on any order with a few items. */}
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

      {/* Envío block */}
      <section aria-label="Envío">
        <h2 className="mb-2 text-sm font-medium text-ink-soft">Envío</h2>
        {envio ? (
          <div className="flex flex-col gap-2 rounded-control bg-surface-2 px-4 py-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-base font-medium text-ink">{envio.carrier}</span>
              <StatusChip tone={envioChip!.tone}>{envioChip!.label}</StatusChip>
            </div>
            {envio.tracking && (
              <span className="text-sm text-ink-soft">
                Tracking: <span className="font-mono text-ink">{envio.tracking}</span>
              </span>
            )}
          </div>
        ) : (
          <div className="rounded-control bg-surface-2 px-4 py-3 text-sm text-ink-soft">
            Retiro en local — sin envío
          </div>
        )}
      </section>

      {/* WhatsApp send — only when phone + pdfUrl are available */}
      {canSendWa && (
        <SecondaryButton
          disabled={sendingWa}
          onClick={() => onSendComprobante(detail.customerPhone!, comprobante.pdfUrl!)}
        >
          {sendingWa ? "Enviando…" : "Enviar comprobante por WhatsApp"}
        </SecondaryButton>
      )}
      {waSentMsg && (
        <p className="text-sm text-ink-soft text-center">{waSentMsg}</p>
      )}

    </Card>
  );
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

const rootEl = document.getElementById("root");
if (rootEl) createRoot(rootEl).render(<DeliveryReceiptWidget />);
