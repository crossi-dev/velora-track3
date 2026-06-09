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

import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { useApp, useHostStyleVariables, useHostFonts } from "@modelcontextprotocol/ext-apps/react";
import { SecondaryButton } from "./_widget-primitives";
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
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function resolveTotal(totals: UCPTotal[]): number {
  const t = totals.find((x) => x.type === "total") ?? totals[0];
  return t ? t.amount : 0;
}

function formatARS(minorUnits: number): string {
  const pesos = minorUnits / 100;
  return "$ " + pesos.toLocaleString("es-AR", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

// ── Envío status chip configuration ──────────────────────────────────────────

interface ChipConfig {
  label: string;
  /** Tailwind utility classes for layout/spacing (not color). */
  classes: string;
  /** Inline color style — uses light-dark() for dark-mode safety. Undefined = no inline style needed. */
  colorStyle?: React.CSSProperties;
}

function resolveEnvioChip(status: string): ChipConfig {
  switch (status) {
    case "delivered":
      return {
        label: "Entregado ✓",
        classes: "",
        // Mirror the onboarding "Conectado" chip pattern: light-dark() vars, not raw Tailwind palette.
        colorStyle: { color: "light-dark(#117a3d, #4ade80)", background: "light-dark(#e7f6ec, #16331f)" },
      };
    case "in_transit":
      return { label: "En tránsito", classes: "bg-surface-2 text-ink" };
    case "failed":
      return { label: "Problema en envío", classes: "bg-danger-surface text-danger-ink" };
    default: // "created" and others
      return { label: "Envío creado", classes: "bg-surface-2 text-ink-soft" };
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

  async function onSendComprobante(phone: string, pdfUrl: string) {
    if (!app) return;
    setSendingWa(true);
    setWaSentMsg(null);
    try {
      // send_whatsapp_text: fields are `to` (phone), `text` (message body), optional `mediaUrl`.
      // pdfUrl is the AFIP fiscal QR URL (not a downloadable PDF), so we include it in the text
      // body rather than as mediaUrl (mediaUrl requires a directly downloadable media file).
      const message = `Hola! Te mando el comprobante de tu compra. QR AFIP: ${pdfUrl}`;
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

  return (
    <main className="mx-auto flex max-w-md flex-col gap-5 p-5 text-ink">

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
            Ver QR AFIP
          </a>
        )}
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

      {/* Envío block */}
      <section aria-label="Envío">
        <h2 className="mb-2 text-sm font-medium text-ink-soft">Envío</h2>
        {envio ? (
          <div className="flex flex-col gap-2 rounded-control bg-surface-2 px-4 py-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-base font-medium text-ink">{envio.carrier}</span>
              <span
                className={`rounded-full px-3 py-1 text-sm font-medium ${envioChip!.classes}`}
                style={envioChip!.colorStyle}
              >
                {envioChip!.label}
              </span>
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

    </main>
  );
}

// ── Presentational primitives ─────────────────────────────────────────────────

function Centered({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="mx-auto max-w-md p-8 text-center text-base text-ink-soft">{children}</div>;
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

const rootEl = document.getElementById("root");
if (rootEl) createRoot(rootEl).render(<DeliveryReceiptWidget />);
