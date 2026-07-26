// caja-status.tsx — MCP App widget for the owner's cash register status view.
//
// READ display + action buttons that call caja_ciclo_caja (abrir/cerrar).
// caja_ciclo_caja owns all idempotency, audit, and financial guards.
//
// Design: status chip (m3.material.io/components/chips/guidelines), native
// semantic elements (W3C ARIA), chameleon theming via useHostStyleVariables.
// Typography: rem units, ≥ 0.875rem minimum per 2026 standards.
//
// Data contract: structuredContent.prefill from open_caja_status tool.
//   state: "OPEN" | "CLOSED" | "NO_SESSION"
//   OPEN:   sessionId, openedAt, openedCashAmount, totalInflows, totalOutflows,
//           expectedCashAmount, movementCount
//   CLOSED: sessionId, closedAt, closedCashAmount, variance
//
// callServerTool wiring (verified against caja-tools.ts inputSchema):
//   caja_ciclo_caja: { action: "abrir" | "cerrar", monto: number, nota?: string }
//
// Safe-area insets (claude.com/docs/connectors/building/mcp-apps/design-guidelines
// #host-context-for-layout): on mobile the chat composer/nav bar can overlay this
// widget's edges — hostContext.safeAreaInsets (px) is added on top of the base
// padding rather than replacing it. Same pattern as business-overview.tsx.
//
// Widget instance supersession (claude.com/docs/connectors/building/mcp-apps/
// instance-supersession): the owner can reasonably re-open this status view mid-
// conversation ("dale, mostrame la caja de nuevo") — only the newest copy should
// stay interactive so an older, stale copy can't fire a caja_ciclo_caja mutation
// (open/close) with numbers Claude has already moved past. Uses its own
// BroadcastChannel ("velora-caja-status-supersede") — separate from
// business-overview's channel so the two widgets' elections never cross-talk.
//
// CSP: no allowUnsafeEval — do NOT add it without a CSP audit.

import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { useApp, useHostStyleVariables, useHostFonts } from "@modelcontextprotocol/ext-apps/react";
import { Card, PrimaryButton, SecondaryButton, Centered, ReturnHint, StatusBanner, StatusChip, SupersededNotice } from "./_widget-primitives";

type CajaState = "OPEN" | "CLOSED" | "NO_SESSION";

interface Prefill {
  state: CajaState;
  /** Election key for instance supersession — see caja-status-render.ts. Optional
   * until the render tool is updated to always set it (server-side dependency;
   * flagged separately). Guarded with Number.isFinite before use. */
  createdAt?: number;
  sessionId?: string;
  openedAt?: string;
  openedCashAmount?: number;
  totalInflows?: number;
  totalOutflows?: number;
  expectedCashAmount?: number;
  movementCount?: number;
  movements?: { type: string; description: string; amount: number; date: string }[];
  closedAt?: string | null;
  closedCashAmount?: number | null;
  variance?: number | null;
}

// Same short-label convention CashMovement.type values map to across the app.
const MOVEMENT_TYPE_LABELS: Record<string, string> = {
  sale: "Venta",
  purchase: "Pago proveedor",
  income: "Ingreso",
  salary: "Sueldo",
  tax: "Impuesto",
  adjustment: "Ajuste",
};

const ars = (n: number | null | undefined) =>
  n != null && Number.isFinite(n)
    ? "$ " + n.toLocaleString("es-AR", { minimumFractionDigits: 0, maximumFractionDigits: 2 })
    : "—";

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleDateString("es-AR", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** numeric=true marks money/count values (tabular-nums, per business-overview's
 * fix) so digits don't jitter the layout as they change width; dates/labels
 * that pass through here (e.g. fmtDate results) leave it unset. */
function Row({ label, value, numeric }: { label: string; value: React.ReactNode; numeric?: boolean }): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className="text-sm text-ink-soft">{label}</dt>
      <dd className={`text-sm font-medium text-ink ${numeric ? "tabular-nums" : ""}`}>{value}</dd>
    </div>
  );
}

function MontoForm({ label, defaultValue, onSubmit, onCancel, submitting, errMsg }: {
  label: string; defaultValue: string;
  onSubmit: (monto: number) => void; onCancel: () => void;
  submitting: boolean; errMsg: string | null;
}): React.JSX.Element {
  const [val, setVal] = useState(defaultValue);
  function trySubmit() {
    const m = parseFloat(val);
    if (!Number.isFinite(m) || m < 0) return;
    onSubmit(m);
  }
  return (
    <div className="flex flex-col gap-3">
      <div>
        <label className="mb-1 block text-sm text-ink-soft">{label}</label>
        <input type="number" min={0} step={0.01} inputMode="decimal"
          className="w-full rounded-control border border-line bg-surface px-3 py-2 text-base text-ink outline-none focus:border-accent"
          value={val} onChange={(e) => setVal(e.target.value)} />
      </div>
      {errMsg && <div className="rounded-control bg-danger-surface p-3 text-sm text-danger-ink" role="alert">{errMsg}</div>}
      <PrimaryButton disabled={submitting} onClick={trySubmit}>
        {submitting ? "Procesando…" : "Confirmar"}
      </PrimaryButton>
      <SecondaryButton onClick={onCancel}>Cancelar</SecondaryButton>
    </div>
  );
}

function CajaStatusWidget(): React.JSX.Element {
  const { app, isConnected, error } = useApp({ appInfo: { name: "caja-status", version: "1.0.0" }, capabilities: {} });
  useHostStyleVariables(app, app?.getHostContext());
  useHostFonts(app, app?.getHostContext());

  const [prefill, setPrefill] = useState<Prefill | null>(null);
  const [received, setReceived] = useState(false);
  const [actionMode, setActionMode] = useState<"abrir" | "cerrar" | null>(null);
  const [actioning, setActioning] = useState(false);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [doneBanner, setDoneBanner] = useState<string | null>(null);
  const [superseded, setSuperseded] = useState(false);

  // Widget instance supersession (see file header) — only the newest copy of
  // this widget stays interactive; older copies gray out instead of both
  // silently letting the owner fire caja_ciclo_caja from stale numbers.
  const instanceIdRef = useRef<string>(crypto.randomUUID());
  const orderKeyRef = useRef<number | undefined>(undefined);
  const keyFinalizedRef = useRef(false);
  const channelRef = useRef<BroadcastChannel | null>(null);
  const peersRef = useRef(new Map<string, { orderKey: number; instanceId: string }>());

  useEffect(() => {
    const channel = new BroadcastChannel("velora-caja-status-supersede");
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
    app.ontoolresult = (params) => {
      setReceived(true);
      const raw = (params.structuredContent ?? params.arguments ?? {}) as { prefill?: Prefill } & Prefill;
      const data = (raw.prefill ?? raw) as Prefill;
      setPrefill(data);
      if (Number.isFinite(data.createdAt)) {
        orderKeyRef.current = data.createdAt;
        keyFinalizedRef.current = true;
        announceInstance();
      }
    };
  }, [app]);

  const doAction = useCallback(async (monto: number) => {
    if (!app || !actionMode || superseded) return;
    setActioning(true); setActionErr(null);
    try {
      // Verified against caja-tools.ts: action: z.enum(["abrir","cerrar"]), monto: z.number().finite().min(0)
      const result = await app.callServerTool({ name: "caja_ciclo_caja", arguments: { action: actionMode, monto } });
      if (result.isError) {
        const raw = (result.content?.[0] as { text?: string } | undefined)?.text ?? "{}";
        let msg = actionMode === "abrir" ? "No se pudo abrir la caja." : "No se pudo cerrar la caja.";
        try { const p = JSON.parse(raw) as { message?: string }; msg = p.message ?? msg; } catch { /* defaults */ }
        setActionErr(msg); return;
      }
      setDoneBanner(actionMode === "abrir" ? `Caja abierta con fondo de ${ars(monto)}.` : `Caja cerrada. Efectivo contado: ${ars(monto)}.`);
      setActionMode(null);
    } catch {
      setActionErr(actionMode === "abrir" ? "No se pudo abrir la caja. Intentá de nuevo." : "No se pudo cerrar la caja. Intentá de nuevo.");
    } finally { setActioning(false); }
  }, [app, actionMode]);

  if (error) return <Centered>No pudimos abrir el estado de caja. {error.message}</Centered>;
  if (!isConnected) return <Centered>Conectando…</Centered>;
  if (!prefill && received) return <Centered>No pudimos cargar el estado de la caja. Probá de nuevo.</Centered>;
  if (!prefill) return <Centered>Cargando estado de caja…</Centered>;

  const safeArea = app?.getHostContext()?.safeAreaInsets;
  const safeAreaStyle: React.CSSProperties = safeArea
    ? {
        paddingTop: `calc(1.25rem + ${safeArea.top}px)`,
        paddingRight: `calc(1.25rem + ${safeArea.right}px)`,
        paddingBottom: `calc(1.25rem + ${safeArea.bottom}px)`,
        paddingLeft: `calc(1.25rem + ${safeArea.left}px)`,
      }
    : {};

  const topHint = superseded ? <SupersededNotice /> : <ReturnHint />;

  if (doneBanner) {
    return (
      <Card title="Estado de caja" style={safeAreaStyle}>
        {topHint}
        <StatusBanner tone="success">{doneBanner}</StatusBanner>
        <p className="text-center text-sm text-ink-soft">Refrescá el estado para ver los datos actualizados.</p>
      </Card>
    );
  }

  if (actionMode) {
    const isAbrir = actionMode === "abrir";
    return (
      <Card title={isAbrir ? "Abrir caja" : "Cerrar caja"} style={safeAreaStyle}>
        {topHint}
        <MontoForm
          label={isAbrir ? "Fondo inicial (ARS)" : "Efectivo contado (ARS)"}
          // JD finding (2026-07-26): this used to pre-fill with expectedCashAmount —
          // the system's OWN number — on close. A till count exists to verify that
          // number independently; pre-filling it meant a tap-through-without-typing
          // always reported variance $0, silently defeating the one control this
          // widget exists to enforce. Starts empty on both paths now, same as "abrir".
          defaultValue="0"
          onSubmit={doAction} onCancel={() => { setActionMode(null); setActionErr(null); }}
          submitting={actioning || superseded} errMsg={actionErr}
        />
        {!isAbrir && prefill.state === "OPEN" && (
          <p className="text-sm text-ink-soft">Efectivo esperado: {ars(prefill.expectedCashAmount)}</p>
        )}
      </Card>
    );
  }

  if (prefill.state === "NO_SESSION") {
    return (
      <Card title="Estado de caja" style={safeAreaStyle}>
        {topHint}
        <div className="flex items-center justify-center rounded-control bg-surface-2 px-4 py-3 text-base text-ink-soft">Sin historial de caja</div>
        <p className="text-sm text-ink-soft">Aún no se registraron turnos en esta caja.</p>
        <PrimaryButton disabled={superseded} onClick={() => { setActionMode("abrir"); setActionErr(null); }}>Abrir caja</PrimaryButton>
      </Card>
    );
  }

  if (prefill.state === "CLOSED") {
    return (
      <Card title="Estado de caja" style={safeAreaStyle}>
        {topHint}
        <section aria-label="Estado del turno" className="flex items-center justify-center rounded-control bg-surface-2 px-4 py-3 text-base font-semibold text-ink-soft">Cerrada</section>
        {/* JD finding (2026-07-26): a cash discrepancy used to be a same-weight
         * `dl` row, just recolored — the least visually weighted fact on a screen
         * where it's the most consequential one. StatusBanner (already used
         * elsewhere for "this just happened" states) gives it real prominence.
         * variance = contado - esperado: negative means cash is MISSING (the
         * actionable, alarming case) — positive just means extra cash landed in
         * the drawer, which is not the same problem and shouldn't wear the same
         * alarm-red the shortfall gets (second follow-up JD pass, same night). */}
        {prefill.variance != null && prefill.variance < 0 && (
          <StatusBanner tone="danger">Faltan {ars(Math.abs(prefill.variance))} — revisá los movimientos del turno</StatusBanner>
        )}
        {prefill.variance != null && prefill.variance > 0 && (
          <StatusBanner tone="neutral">Sobran {ars(prefill.variance)} respecto a lo esperado</StatusBanner>
        )}
        <dl className="flex flex-col gap-2 rounded-control bg-surface-2 px-4 py-3">
          <Row label="Cerrada" value={fmtDate(prefill.closedAt)} />
          <Row label="Efectivo contado" value={ars(prefill.closedCashAmount)} numeric />
          {prefill.variance != null && (
            <Row label="Diferencia" numeric value={
              <span className={prefill.variance < 0 ? "text-danger-ink" : undefined}>{ars(prefill.variance)}</span>
            } />
          )}
        </dl>
        <PrimaryButton disabled={superseded} onClick={() => { setActionMode("abrir"); setActionErr(null); }}>Abrir caja</PrimaryButton>
      </Card>
    );
  }

  // OPEN state
  return (
    <Card title="Estado de caja" style={safeAreaStyle}>
      {topHint}
      <section aria-label="Saldo actual" className="flex flex-col items-center gap-1 rounded-control bg-surface-2 px-4 py-4">
        <span className="text-sm text-ink-soft">Efectivo esperado</span>
        <span className="text-4xl font-bold tabular-nums text-ink">{ars(prefill.expectedCashAmount)}</span>
        <span className="mt-1">
          <StatusChip tone="success">Turno abierto</StatusChip>
        </span>
      </section>
      <dl className="flex flex-col gap-2 rounded-control bg-surface-2 px-4 py-3">
        <Row label="Abierta" value={fmtDate(prefill.openedAt)} />
        <Row label="Fondo inicial" value={ars(prefill.openedCashAmount)} numeric />
        <Row label="Ingresos" value={ars(prefill.totalInflows)} numeric />
        <Row label="Egresos" value={prefill.totalOutflows != null ? ars(-Math.abs(prefill.totalOutflows)) : "—"} numeric />
        {prefill.movementCount != null && <Row label="Movimientos" value={String(prefill.movementCount)} numeric />}
      </dl>
      {/* JD integration-map finding (2026-07-26): the owner could see the blended
       * total but never which lines made it up. Collapsed by default so the default
       * view stays within the inline data-point budget — "reveal complexity only
       * when users need it" — expands to an itemized, capped list on demand. */}
      {!!prefill.movements?.length && (
        <details className="rounded-control bg-surface-2 px-4 py-3">
          <summary className="cursor-pointer text-sm font-medium text-ink-soft">Ver detalle de movimientos</summary>
          <ul className="mt-2 flex flex-col gap-2">
            {prefill.movements.map((m, i) => (
              <li key={i} className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-sm text-ink">{MOVEMENT_TYPE_LABELS[m.type] ?? m.type}{m.description ? ` — ${m.description}` : ""}</div>
                  <div className="text-sm text-ink-soft">{fmtDate(m.date)}</div>
                </div>
                <span className={`shrink-0 text-sm font-medium tabular-nums ${m.amount < 0 ? "text-danger-ink" : "text-ink"}`}>
                  {ars(m.amount)}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
      <SecondaryButton disabled={superseded} onClick={() => { setActionMode("cerrar"); setActionErr(null); }}>Cerrar caja</SecondaryButton>
    </Card>
  );
}

const rootEl = document.getElementById("root");
if (rootEl) createRoot(rootEl).render(<CajaStatusWidget />);
