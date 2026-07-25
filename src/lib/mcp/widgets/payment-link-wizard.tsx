// payment-link-wizard.tsx — authored MCP App widget for the payment-link wizard.
// Renders inside the host's sandboxed iframe (Cowork / ChatGPT) as a ui:// resource,
// bundled to a self-contained HTML string by scripts/build-widget.mjs.
//
// Design — industry-sourced, host-agnostic (verified 2026-06-07, all HTTP 200):
//  - Editable line items: each row shows name + unit price + EDITABLE quantity
//    (min 1) + subtotal, and the total recalculates live. Standard per Stripe
//    "adjustable quantity" (docs.stripe.com/payments/checkout/adjustable-quantity),
//    Baymard checkout research (baymard.com/research/checkout-usability — inline
//    quantity editing, price+qty visible per line) and Square invoices.
//  - Customer selector: owner can change the customer during review via an inline
//    search (no modal, no nested scroll). Pattern: Stripe invoice creation "select
//    an existing customer" (docs.stripe.com/get-started/use-cases/invoices).
//    Matches capped at 6 (short list, no scroll). Changing customer regenerates the
//    idempotency key (a changed customer = a new logical cobro).
//  - One primary action, card auto-fits, no nested scroll, no tabs — OpenAI Apps
//    SDK UI guidelines (developers.openai.com/apps-sdk/concepts/ui-guidelines).
//  - Native semantic elements for a11y (W3C First Rule of ARIA, w3.org/TR/using-aria).
//  - Chameleon theming: Tailwind v4 mapped (widget.css @theme) to the host's
//    MCP-App CSS variables via ext-apps useHostStyleVariables/useHostFonts.
// MONEY (NABAOS): the displayed total is derived from catalog prices the render
// tool resolved; the AUTHORITATIVE charge is recomputed server-side by the write
// tool from items × catalog price — never from a typed amount.
// CSP: Zod ships via ext-apps but its JIT is disabled because `capabilities` does
// not include `allowUnsafeEval`. Do NOT add `allowUnsafeEval` without a CSP audit.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { useApp, useHostStyleVariables, useHostFonts } from "@modelcontextprotocol/ext-apps/react";
import { CustomerField, type CustomerMatch } from "./customer-field";
import { Card, Field, PrimaryButton, SecondaryButton, Centered } from "./_widget-primitives";

interface PrefillItem {
  productId: string;
  quantity: number;
  name: string;
  unitPrice: number;
  unitPriceOverride?: number;
}
interface Prefill {
  description: string;
  customerId: string;
  customerName?: string;
  items: PrefillItem[];
  totalARS: number;
}

function errorCopy(code: string, fallback: string): string {
  switch (code) {
    case "mp_not_connected": return "MercadoPago no está conectado. Configurá tu cuenta en Ajustes para generar links de cobro.";
    case "mp_token_expired": return "La sesión de MercadoPago expiró. Reconectá tu cuenta en Ajustes.";
    case "mp_decrypt_error": return "No pudimos leer tus credenciales de MercadoPago. Contactá soporte.";
    case "validation": return fallback || "Revisá los datos del cobro.";
    default: return fallback || "No se pudo crear el link de cobro. Intentá de nuevo o contactá soporte.";
  }
}

const ars = (n: number) => Number.isFinite(n) ? "$ " + n.toLocaleString("es-AR", { minimumFractionDigits: 0, maximumFractionDigits: 2 }) : "—";

function PaymentLinkWizard(): React.JSX.Element {
  const { app, isConnected, error } = useApp({
    appInfo: { name: "payment-link-wizard", version: "1.0.0" },
    capabilities: {},
  });
  useHostStyleVariables(app, app?.getHostContext());
  useHostFonts(app, app?.getHostContext());

  const [prefill, setPrefill] = useState<Prefill | null>(null);
  const [toolResultReceived, setToolResultReceived] = useState(false);
  const [items, setItems] = useState<PrefillItem[]>([]);
  // Customer identity — lifted so owner can change before confirming (see CustomerField sibling).
  const [customerId, setCustomerId] = useState<string>("");
  const [customerName, setCustomerName] = useState<string>("");
  const [pickingCustomer, setPickingCustomer] = useState(false);
  const [customerQuery, setCustomerQuery] = useState("");
  const [customerMatches, setCustomerMatches] = useState<CustomerMatch[]>([]);
  const [searchingCustomer, setSearchingCustomer] = useState(false);
  const [customerSearchError, setCustomerSearchError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [linkUrl, setLinkUrl] = useState<string | null>(null);
  const [paymentIntentId, setPaymentIntentId] = useState<string | null>(null);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const idempotencyKey = useRef<string>(crypto.randomUUID());

  useEffect(() => {
    if (!app) return;
    // Render data arrives ONLY via ontoolresult (ui/notifications/tool-result → structuredContent).
    // ontoolinput is intentionally NOT wired: it carries the tool INPUT args (no resolved fields) and would flash NaN/undefined.
    const apply = (params: { structuredContent?: unknown; arguments?: unknown }) => {
      setToolResultReceived(true);
      const raw = (params.structuredContent ?? params.arguments ?? {}) as { prefill?: Prefill } & Prefill;
      const args = (raw.prefill ?? raw) as Prefill;
      setPrefill(args);
      setItems(args.items ?? []);
      setCustomerId(args.customerId ?? "");
      setCustomerName(args.customerName ?? "Cliente sin nombre");
    };
    app.ontoolresult = (params) => apply(params);
  }, [app]);

  // Live total recomputed from the (editable) line quantities × unit price.
  const total = useMemo(() => items.reduce((s, it) => s + it.quantity * it.unitPrice, 0), [items]);

  function setQty(i: number, next: number) {
    const q = Math.max(1, Math.floor(Number.isFinite(next) ? next : 1)); // min 1 (Stripe adjustable-quantity)
    // Regenerate idempotency key on quantity edit so an edited cart submits a
    // fresh key and avoids idempotency_conflict on edit-then-retry.
    idempotencyKey.current = crypto.randomUUID();
    setItems((prev) => prev.map((it, idx) => (idx === i ? { ...it, quantity: q } : it)));
  }

  // find_customer returns: content[0].text = JSON.stringify({ customers: CustomerMatch[], total: number })
  const onSearchCustomer = useCallback(async () => {
    if (!app || !customerQuery.trim()) return;
    setSearchingCustomer(true);
    setCustomerSearchError(null);
    setCustomerMatches([]);
    try {
      const result = await app.callServerTool({
        name: "find_customer",
        arguments: { name: customerQuery.trim() },
      });
      if (result.isError) {
        const raw = (result.content?.[0] as { text?: string } | undefined)?.text ?? "{}";
        let message = "No se pudieron buscar clientes.";
        try { const p = JSON.parse(raw); message = p.message ?? message; } catch { /* defaults */ }
        setCustomerSearchError(message);
        return;
      }
      const raw = (result.content?.[0] as { text?: string } | undefined)?.text ?? "{}";
      let matches: CustomerMatch[] = [];
      try {
        const parsed = JSON.parse(raw) as { customers?: CustomerMatch[] };
        matches = parsed.customers ?? [];
      } catch { /* empty result */ }
      setCustomerMatches(matches.slice(0, 6)); // cap at 6 — no nested scroll per UI guidelines
      if (matches.length === 0) setCustomerSearchError("No se encontraron clientes con ese nombre.");
    } catch {
      setCustomerSearchError("Error al buscar clientes. Intentá de nuevo.");
    } finally {
      setSearchingCustomer(false);
    }
  }, [app, customerQuery]);

  function onPickCustomer(match: CustomerMatch) {
    setCustomerId(match.id);
    setCustomerName(match.name);
    idempotencyKey.current = crypto.randomUUID(); // new customer = new cobro — new idempotency key
    setPickingCustomer(false);
    setCustomerQuery("");
    setCustomerMatches([]);
    setCustomerSearchError(null);
  }

  function onCancelPicker() { setPickingCustomer(false); setCustomerQuery(""); setCustomerMatches([]); setCustomerSearchError(null); }

  async function onConfirm() {
    if (!app || !prefill) return;
    setSubmitting(true);
    setErrMsg(null);
    try {
      const result = await app.callServerTool({
        name: "create_tracked_payment_link",
        arguments: {
          customerId,
          items: items.map((it) => ({
            productId: it.productId,
            quantity: it.quantity,
            ...(typeof it.unitPriceOverride === "number" ? { unitPriceOverride: it.unitPriceOverride } : {}),
          })),
          // Description is DERIVED from the line items (the products ARE the detail).
          // No separate editable free-text field — that would duplicate/contradict the
          // line items. Standard: Stripe/Square invoices use line items as the detail.
          description: items.map((it) => `${it.quantity}× ${it.name}`).join(", "),
          expiresInDays: 3,
          idempotencyKey: idempotencyKey.current,
        },
      });
      if (result.isError) {
        const raw = (result.content?.[0] as { text?: string } | undefined)?.text ?? "{}";
        let code = "mp_api_error";
        let message = "";
        try { const p = JSON.parse(raw); code = p.error ?? code; message = p.message ?? ""; } catch { /* defaults */ }
        setErrMsg(errorCopy(code, message));
        return;
      }
      const sc = result.structuredContent as { paymentLinkUrl?: string; paymentIntentId?: string } | undefined;
      setLinkUrl(sc?.paymentLinkUrl ?? null);
      setPaymentIntentId(sc?.paymentIntentId ?? null);
    } catch {
      setErrMsg(errorCopy("mp_api_error", ""));
    } finally {
      setSubmitting(false);
    }
  }

  async function onViewCobro() {
    if (!app || !paymentIntentId) return;
    await app.callServerTool({ name: "open_cobro_status", arguments: { paymentIntentId } }).catch(() => {
      setErrMsg("No se pudo abrir el estado del cobro. Intentá de nuevo.");
    });
  }

  async function onCopy() {
    if (!linkUrl) return;
    try { await navigator.clipboard.writeText(linkUrl); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* blocked */ }
  }

  if (error) return <Centered>No pudimos abrir el asistente de cobro. {error.message}</Centered>;
  if (!isConnected) return <Centered>Conectando…</Centered>;
  if (!prefill && toolResultReceived) return <Centered>No pudimos cargar los datos del cobro. Probá de nuevo.</Centered>;
  if (!prefill) return <Centered>Esperando los datos del cobro…</Centered>;

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

  if (linkUrl) {
    return (
      <Card title="Link de cobro listo" style={safeAreaStyle}>
        <p className="text-sm text-ink-soft">Compartí este link con tu cliente para que pague.</p>
        <div className="rounded-control bg-surface-2 p-3 text-sm break-all text-ink">{linkUrl}</div>
        <PrimaryButton onClick={onCopy}>{copied ? "¡Copiado!" : "Copiar link"}</PrimaryButton>
        {paymentIntentId && (
          <SecondaryButton onClick={onViewCobro}>Ver estado del cobro</SecondaryButton>
        )}
      </Card>
    );
  }

  // Empty cobro — the render tool resolved no line items; show an error instead of a confusing "$ 0" form.
  if (items.length === 0) {
    return <Centered>No pudimos cargar los productos de este cobro. Probá de nuevo desde Velora.</Centered>;
  }

  return (
    <Card title="Revisá el cobro" style={safeAreaStyle}>
      <CustomerField
        customerName={customerName}
        pickingCustomer={pickingCustomer}
        customerQuery={customerQuery}
        customerMatches={customerMatches}
        searchingCustomer={searchingCustomer}
        customerSearchError={customerSearchError}
        onStartPick={() => setPickingCustomer(true)}
        onCancelPick={onCancelPicker}
        onQueryChange={setCustomerQuery}
        onSearch={onSearchCustomer}
        onPickCustomer={onPickCustomer}
      />

      <div>
        <div className="mb-1 text-sm text-ink-soft">Productos</div>
        <ul className="flex flex-col gap-2">
          {items.map((it, i) => (
            <li key={it.productId} className="flex items-center justify-between gap-3 rounded-control bg-surface-2 p-3">
              <div className="min-w-0">
                <div className="truncate text-base text-ink">{it.name}</div>
                <div className="text-sm tabular-nums text-ink-soft">{ars(it.unitPrice)} c/u · {ars(it.quantity * it.unitPrice)}</div>
              </div>
              <label className="flex items-center gap-1 text-sm text-ink-soft">
                <span className="sr-only">Cantidad de {it.name}</span>
                <input
                  type="number"
                  min={1}
                  inputMode="numeric"
                  className="w-16 rounded-control border border-line bg-surface px-2 py-2 text-center text-base text-ink outline-none focus:border-accent"
                  value={it.quantity}
                  onChange={(e) => setQty(i, parseInt(e.target.value, 10))}
                />
              </label>
            </li>
          ))}
        </ul>
      </div>

      <Field label="Total a cobrar">
        <span className="text-3xl font-bold leading-tight tabular-nums text-ink">{ars(total)}</span>
      </Field>

      <p className="text-sm text-ink-soft">El link vence en 3 días. El total se calcula con los precios de tu catálogo.</p>
      {!customerId && (
        <p className="text-sm text-danger-ink" role="alert">Seleccioná un cliente para poder generar el link.</p>
      )}
      {errMsg && <div className="rounded-control bg-danger-surface p-3 text-sm text-danger-ink" role="alert">{errMsg}</div>}
      {/* SAFETY: confirm is blocked until a customer is selected — charging without a customer is not allowed. */}
      <PrimaryButton disabled={submitting || !customerId} onClick={onConfirm}>
        {submitting ? "Generando…" : "Confirmar y generar link"}
      </PrimaryButton>
    </Card>
  );
}

const rootEl = document.getElementById("root");
if (rootEl) createRoot(rootEl).render(<PaymentLinkWizard />);
