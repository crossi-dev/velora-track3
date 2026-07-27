// sale-confirm.tsx — MCP App widget for sale preview + confirmation.
//
// UNIFIED SALE FLOW (Carlos, 2026-07-26): one widget that ASKS how the customer
// pays — efectivo (cash) or QR/link (MercadoPago) — and routes to the correct
// REAL backend action. No more picking between two disconnected tools.
//
// MONEY PATH (NABAOS): the displayed prices and total are resolved from the
// catalog by the render tool (open_sale_confirm) — never from typed amounts.
// Two mutually-exclusive branches, each fired via callServerTool:
//   - Cash  → register_sale. Recomputes the authoritative price from the catalog
//             server-side, owns idempotency + all audit/inventory guards. Money
//             is COLLECTED → "Venta registrada / Total cobrado ✓".
//   - QR    → create_tracked_payment_link. Atomically records Sale+Invoice+
//             PaymentIntent and returns a REAL MercadoPago Checkout Pro link.
//             Money is NOT collected yet → "Link generado / esperando pago".
//             REQUIRES a customer (the backend rejects anonymous cobros), so the
//             QR option is blocked for consumidor final — surfaced, not faked.
// The two branches never both fire: create_tracked_payment_link records its OWN
// sale, so calling register_sale as well would double-record.
//
// Pattern: preview→confirm (same safe pattern as payment-link-wizard).
// No-customer path: customerId may be empty (consumidor final) — register_sale
// allows anonymous sales; the QR branch does not.
//
// Design principles (industry-sourced, HTTP 200 verified):
//   - One primary action, no nested scroll — OpenAI Apps SDK UI guidelines
//     (developers.openai.com/apps-sdk/concepts/ui-guidelines).
//   - Native semantic elements: <main>, <ul>, <li>, radiogroup (W3C First Rule of ARIA).
//   - Chameleon theming: Tailwind v4 mapped to host CSS variables via
//     ext-apps useHostStyleVariables/useHostFonts.
//   - Typography: rem units, ≥ 0.875rem (14px) minimum per 2026 standards.
//
// Data contract: structuredContent.prefill from open_sale_confirm tool.
//   { items: [{productId, quantity, name, unitPrice}], customerId, customerName, customerPhone, totalARS }
//
// CSP: no allowUnsafeEval — do NOT add it without a CSP audit.

import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { useApp, useHostStyleVariables, useHostFonts } from "@modelcontextprotocol/ext-apps/react";
import { Card, Field, PrimaryButton, SecondaryButton, Centered, InlineSkeleton, SupersededNotice } from "./_widget-primitives";

// Same cap convention as pending-orders.tsx's DISPLAY_CAP — the host clips
// (doesn't scroll) inline content past its height, so an uncapped item list
// can push "Total a cobrar" and the confirm button off-screen (JD, 2026-07-26).
const LINE_ITEMS_CAP = 10;

// ── Types ─────────────────────────────────────────────────────────────────────

type PaymentChoice = "efectivo" | "qr";

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
  customerPhone: string | null;
  totalARS: number;
  /** Server-assigned render timestamp (epoch ms), used ONLY as the widget
   * instance-supersession election key (claude.com/docs/connectors/building/
   * mcp-apps/instance-supersession) — NOT a business date. Optional because an
   * unpatched server degrades to "no supersession" instead of crashing;
   * guarded with Number.isFinite below. */
  createdAt?: number;
  /** Monotonic per-process tie-breaker for createdAt collisions (same-ms calls) —
   * claude.com/docs/connectors/building/mcp-apps/instance-supersession. */
  seq?: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const ars = (n: number) =>
  Number.isFinite(n)
    ? "$ " + n.toLocaleString("es-AR", { minimumFractionDigits: 0, maximumFractionDigits: 2 })
    : "—";

// MercadoPago error copy — mirrors payment-link-wizard.tsx's errorCopy so the QR
// branch speaks the owner's language on the same failure modes.
function mpErrorCopy(code: string, fallback: string): string {
  switch (code) {
    case "mp_not_connected": return "MercadoPago no está conectado. Configurá tu cuenta en Ajustes para generar links de cobro.";
    case "mp_token_expired": return "La sesión de MercadoPago expiró. Reconectá tu cuenta en Ajustes.";
    case "mp_decrypt_error": return "No pudimos leer tus credenciales de MercadoPago. Contactá soporte.";
    case "validation": return fallback || "Revisá los datos del cobro.";
    default: return fallback || "No se pudo crear el link de cobro. Intentá de nuevo o contactá soporte.";
  }
}

// Segmented-control button classes — shared by the two payment-choice options.
const segClass = (active: boolean) =>
  `flex-1 rounded-control px-4 py-3 text-base font-medium transition-colors ${
    active
      ? "bg-brand text-on-brand"
      : "border border-line bg-surface text-ink hover:bg-surface-2"
  }`;

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
  const [paymentMethod, setPaymentMethod] = useState<PaymentChoice>("efectivo");
  const [submitting, setSubmitting] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [superseded, setSuperseded] = useState(false);

  // Widget instance supersession (claude.com/docs/connectors/building/mcp-apps/
  // instance-supersession) — this widget fires REAL money mutations
  // (register_sale, create_tracked_payment_link). If the owner re-asks for the
  // same sale mid-conversation, only the newest copy should stay interactive —
  // an older copy must not also fire the mutation. Same election pattern as
  // cobro-status.tsx / delivery-receipt.tsx. Channel is scoped per-conversation
  // by default (no fixed _meta.ui.domain set on this resource).
  const instanceIdRef = useRef<string>(crypto.randomUUID());
  const orderKeyRef = useRef<number | undefined>(undefined);
  const seqRef = useRef<number | undefined>(undefined);
  const keyFinalizedRef = useRef(false);
  const channelRef = useRef<BroadcastChannel | null>(null);
  const peersRef = useRef(new Map<string, { orderKey: number; seq?: number; instanceId: string }>());

  useEffect(() => {
    const channel = new BroadcastChannel("velora-sale-confirm-supersede");
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

  // Cash branch state.
  const [confirmed, setConfirmed] = useState(false);
  const [saleId, setSaleId] = useState<string | null>(null);
  const [sendingWa, setSendingWa] = useState(false);
  const [waSentMsg, setWaSentMsg] = useState<string | null>(null);

  // QR branch state.
  const [linkUrl, setLinkUrl] = useState<string | null>(null);
  const [paymentIntentId, setPaymentIntentId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [sendingLinkWa, setSendingLinkWa] = useState(false);
  const [linkWaMsg, setLinkWaMsg] = useState<string | null>(null);
  // Stable idempotency key generated once on form open (same pattern as payment-link-wizard):
  // a retry after a transient failure reuses it → the backend dedupes, no double cobro.
  const idempotencyKey = useRef<string>(crypto.randomUUID());

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
      if (Number.isFinite(args.createdAt)) {
        orderKeyRef.current = args.createdAt;
        seqRef.current = Number.isFinite(args.seq) ? args.seq : undefined;
        keyFinalizedRef.current = true;
        announceInstance();
      }
    };
    app.ontoolresult = (params) => apply(params);
  }, [app]);

  // ── Cash branch: register_sale ────────────────────────────────────────────
  const onConfirm = useCallback(async () => {
    if (!app || !prefill || superseded) return;
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
  }, [app, prefill, superseded]);

  // ── QR branch: create_tracked_payment_link ────────────────────────────────
  // Same write tool the payment-link wizard confirms with. Records Sale+Invoice+
  // PaymentIntent server-side and returns a REAL MercadoPago Checkout Pro link.
  // Blocked (button disabled) when there is no customer — the backend rejects
  // anonymous cobros, so we never fire a call that is guaranteed to fail.
  const onGenerateLink = useCallback(async () => {
    if (!app || !prefill || !prefill.customerId || superseded) return;
    setSubmitting(true);
    setErrMsg(null);
    try {
      const result = await app.callServerTool({
        name: "create_tracked_payment_link",
        arguments: {
          customerId: prefill.customerId,
          items: prefill.items.map((it) => ({
            productId: it.productId,
            quantity: it.quantity,
            // unitPriceOverride omitted — the backend uses catalog price as authoritative.
          })),
          // Description DERIVED from line items (the products ARE the detail) — same
          // convention as payment-link-wizard.
          description: prefill.items.map((it) => `${it.quantity}× ${it.name}`).join(", "),
          expiresInDays: 3,
          idempotencyKey: idempotencyKey.current,
        },
      });
      if (result.isError) {
        const raw = (result.content?.[0] as { text?: string } | undefined)?.text ?? "{}";
        let code = "mp_api_error";
        let message = "";
        try {
          const p = JSON.parse(raw) as { error?: string; message?: string };
          code = p.error ?? code;
          message = p.message ?? "";
        } catch { /* defaults */ }
        setErrMsg(mpErrorCopy(code, message));
        return;
      }
      const sc = result.structuredContent as { paymentLinkUrl?: string; paymentIntentId?: string } | undefined;
      setLinkUrl(sc?.paymentLinkUrl ?? null);
      setPaymentIntentId(sc?.paymentIntentId ?? null);
    } catch {
      setErrMsg(mpErrorCopy("mp_api_error", ""));
    } finally {
      setSubmitting(false);
    }
  }, [app, prefill, superseded]);

  // Carlos (2026-07-26): the confirmed screen previously left the customer with
  // nothing — no receipt, no confirmation on their end, even though a phone was
  // often on file. Mirrors delivery-receipt.tsx's onSendComprobante pattern
  // (same send_whatsapp_text tool, same to/text argument shape).
  const onSendReceipt = useCallback(async () => {
    if (!app || !prefill?.customerPhone) return;
    setSendingWa(true);
    setWaSentMsg(null);
    try {
      const itemLines = prefill.items
        .map((it) => `${it.quantity}x ${it.name}`)
        .join(", ");
      const message =
        `¡Hola! Te confirmamos tu compra: ${itemLines}. ` +
        `Total pagado en efectivo: ${ars(prefill.totalARS)}. ¡Gracias por tu compra!`;
      const result = await app.callServerTool({
        name: "send_whatsapp_text",
        arguments: { to: prefill.customerPhone, text: message },
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
  }, [app, prefill]);

  // QR branch: send the generated payment link to the customer over WhatsApp so
  // the owner can actually deliver it (a link they can't send is half a flow).
  // Reuses the same send_whatsapp_text tool as the cash receipt.
  const onSendLink = useCallback(async () => {
    if (!app || !prefill?.customerPhone || !linkUrl) return;
    setSendingLinkWa(true);
    setLinkWaMsg(null);
    try {
      const itemLines = prefill.items.map((it) => `${it.quantity}x ${it.name}`).join(", ");
      const message =
        `¡Hola! Acá está tu link para pagar: ${itemLines}. ` +
        `Total: ${ars(prefill.totalARS)}. Pagá con MercadoPago desde este link: ${linkUrl}`;
      const result = await app.callServerTool({
        name: "send_whatsapp_text",
        arguments: { to: prefill.customerPhone, text: message },
      });
      if (result.isError) {
        const raw = (result.content?.[0] as { text?: string } | undefined)?.text ?? "{}";
        let msg = "No se pudo enviar el link.";
        try { const p = JSON.parse(raw) as { message?: string }; msg = p.message ?? msg; } catch { /* default */ }
        setLinkWaMsg(msg);
      } else {
        setLinkWaMsg("Link enviado por WhatsApp.");
      }
    } catch {
      setLinkWaMsg("No se pudo enviar el link. Intentá de nuevo.");
    } finally {
      setSendingLinkWa(false);
    }
  }, [app, prefill, linkUrl]);

  const onCopyLink = useCallback(async () => {
    if (!linkUrl) return;
    try {
      await navigator.clipboard.writeText(linkUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard blocked in this host — the link is still shown for manual copy */ }
  }, [linkUrl]);

  // Chaining into a DIFFERENT widget via a direct callServerTool from inside
  // this one was live-confirmed to succeed server-side but never render a
  // new widget (docs/TODO-widget-initiated-tool-call-no-render.md). Prefer
  // app.sendMessage — confirmed working live 2026-07-27 for the same pattern
  // in catalog-selector.tsx. Falls back to the direct call on hosts without
  // the `message` capability.
  const onViewCobro = useCallback(async () => {
    if (!app || !paymentIntentId) return;
    if (app.getHostCapabilities()?.message) {
      await app.sendMessage({
        role: "user",
        content: [{ type: "text", text: `Mostrame el estado del cobro de ${prefill?.customerName ?? "este cliente"}.` }],
      }).catch(() => setErrMsg("No se pudo abrir el estado del cobro. Intentá de nuevo."));
      return;
    }
    await app.callServerTool({ name: "open_cobro_status", arguments: { paymentIntentId } }).catch(() => {
      setErrMsg("No se pudo abrir el estado del cobro. Intentá de nuevo.");
    });
  }, [app, paymentIntentId, prefill]);

  // ── Loading / error states ────────────────────────────────────────────────

  if (error) return <Centered>No pudimos abrir la confirmación de venta. {error.message}</Centered>;
  if (!isConnected) return <Centered>Conectando…</Centered>;
  if (!prefill && toolResultReceived)
    return <Centered>No pudimos cargar los datos de la venta. Probá de nuevo.</Centered>;
  if (!prefill) return <InlineSkeleton rows={3} label="Cargando venta" />;

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

  // ── QR branch: link-ready screen ──────────────────────────────────────────
  // NOT "cobrado" — a payment link is money PENDING, not collected. Distinct copy
  // + pending tone so the owner never confuses it with a completed cash sale.
  if (linkUrl) {
    return (
      <Card title="Link de cobro generado" style={safeAreaStyle}>
        <div className="rounded-control bg-surface-2 px-4 py-3 text-ink-soft">
          <p className="text-base font-medium text-ink">Todavía no cobraste</p>
          <p className="text-sm">
            Compartí este link con {prefill.customerName !== "Consumidor final" ? prefill.customerName : "tu cliente"} para
            que pague por MercadoPago. El pago queda pendiente hasta que lo complete.
          </p>
        </div>

        <div className="flex items-center justify-between rounded-control bg-surface-2 px-4 py-3 text-ink">
          <span className="text-base font-medium">Total a cobrar</span>
          <span className="text-xl font-bold tabular-nums">{ars(prefill.totalARS)}</span>
        </div>

        <div className="rounded-control bg-surface-2 p-3 text-sm break-all text-ink">{linkUrl}</div>

        <PrimaryButton onClick={onCopyLink}>{copied ? "¡Copiado!" : "Copiar link"}</PrimaryButton>

        {prefill.customerPhone && (
          <>
            <SecondaryButton disabled={sendingLinkWa} onClick={onSendLink}>
              {sendingLinkWa ? "Enviando…" : "Enviar link por WhatsApp"}
            </SecondaryButton>
            {linkWaMsg && <p className="text-sm text-ink-soft">{linkWaMsg}</p>}
          </>
        )}

        {paymentIntentId && (
          <SecondaryButton onClick={onViewCobro}>Ver estado del cobro</SecondaryButton>
        )}

        {errMsg && (
          <div className="rounded-control bg-danger-surface p-3 text-sm text-danger-ink" role="alert">
            {errMsg}
          </div>
        )}
      </Card>
    );
  }

  // ── Cash branch: confirmation screen ──────────────────────────────────────

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
        {prefill.customerPhone && (
          <>
            <SecondaryButton disabled={sendingWa} onClick={onSendReceipt}>
              {sendingWa ? "Enviando…" : "Enviar comprobante por WhatsApp"}
            </SecondaryButton>
            {waSentMsg && <p className="text-sm text-ink-soft">{waSentMsg}</p>}
          </>
        )}
      </Card>
    );
  }

  // ── Empty items guard ─────────────────────────────────────────────────────

  if (prefill.items.length === 0) {
    return <Centered>No se cargaron productos para esta venta. Probá de nuevo desde Velora.</Centered>;
  }

  // ── Preview screen ────────────────────────────────────────────────────────

  const hasCustomer = Boolean(prefill.customerId);
  const qrBlocked = paymentMethod === "qr" && !hasCustomer;

  return (
    <Card title="Confirmar venta" style={safeAreaStyle}>
      {superseded && <SupersededNotice />}
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

      {/* Payment-method choice — the unified "how do they pay?" step. */}
      <Field label="¿Cómo paga el cliente?">
        <div role="radiogroup" aria-label="Método de pago" className="flex gap-2">
          <button
            type="button"
            role="radio"
            aria-checked={paymentMethod === "efectivo"}
            onClick={() => setPaymentMethod("efectivo")}
            className={segClass(paymentMethod === "efectivo")}
          >
            Efectivo
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={paymentMethod === "qr"}
            onClick={() => setPaymentMethod("qr")}
            className={segClass(paymentMethod === "qr")}
          >
            QR / Link de pago
          </button>
        </div>
      </Field>

      <p className="text-sm text-ink-soft">
        {paymentMethod === "efectivo"
          ? "Cobrás en efectivo ahora. El total se calcula con los precios del catálogo."
          : "Generás un link de MercadoPago para que el cliente pague. El total se calcula con los precios del catálogo."}
      </p>

      {/* QR requires a customer — the backend rejects anonymous cobros. Say why
       * instead of firing a call that is guaranteed to fail. */}
      {qrBlocked && (
        <div className="rounded-control bg-danger-surface p-3 text-sm text-danger-ink" role="alert">
          Para cobrar con QR o link necesitás un cliente. Volvé a abrir la venta eligiendo un cliente, o cobrá en efectivo.
        </div>
      )}

      {/* JD finding (2026-07-26): this screen fires a real mutation with zero
       * guardrail on a $0 total — far more likely a forgotten price than an
       * intentional freebie. Block confirm and say why. */}
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

      {paymentMethod === "efectivo" ? (
        <PrimaryButton disabled={submitting || superseded || prefill.totalARS <= 0} onClick={onConfirm}>
          {submitting ? "Registrando…" : "Confirmar venta"}
        </PrimaryButton>
      ) : (
        <PrimaryButton disabled={submitting || superseded || prefill.totalARS <= 0 || !hasCustomer} onClick={onGenerateLink}>
          {submitting ? "Generando…" : "Generar link de cobro"}
        </PrimaryButton>
      )}
    </Card>
  );
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

const rootEl = document.getElementById("root");
if (rootEl) createRoot(rootEl).render(<SaleConfirmWidget />);
