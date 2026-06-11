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
// CSP: no allowUnsafeEval — do NOT add it without a CSP audit.

import React, { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { useApp, useHostStyleVariables, useHostFonts } from "@modelcontextprotocol/ext-apps/react";
import { Card, Field, PrimaryButton, SecondaryButton, Centered } from "./_widget-primitives";

type CajaState = "OPEN" | "CLOSED" | "NO_SESSION";

interface Prefill {
  state: CajaState;
  sessionId?: string;
  openedAt?: string;
  openedCashAmount?: number;
  totalInflows?: number;
  totalOutflows?: number;
  expectedCashAmount?: number;
  movementCount?: number;
  closedAt?: string | null;
  closedCashAmount?: number | null;
  variance?: number | null;
}

const ars = (n: number | null | undefined) =>
  n != null && Number.isFinite(n)
    ? "$ " + n.toLocaleString("es-AR", { minimumFractionDigits: 0, maximumFractionDigits: 2 })
    : "—";

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleDateString("es-AR", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function Row({ label, value }: { label: string; value: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className="text-sm text-ink-soft">{label}</dt>
      <dd className="text-sm font-medium text-ink">{value}</dd>
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

  useEffect(() => {
    if (!app) return;
    app.ontoolresult = (params) => {
      setReceived(true);
      const raw = (params.structuredContent ?? params.arguments ?? {}) as { prefill?: Prefill } & Prefill;
      setPrefill((raw.prefill ?? raw) as Prefill);
    };
  }, [app]);

  const doAction = useCallback(async (monto: number) => {
    if (!app || !actionMode) return;
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

  if (doneBanner) {
    return (
      <Card title="Estado de caja">
        <div className="flex items-center justify-center rounded-control px-4 py-3 text-base font-semibold"
          style={{ color: "light-dark(#117a3d, #4ade80)", background: "light-dark(#e7f6ec, #16331f)" }}>
          {doneBanner}
        </div>
        <p className="text-center text-sm text-ink-soft">Refrescá el estado para ver los datos actualizados.</p>
      </Card>
    );
  }

  if (actionMode) {
    const isAbrir = actionMode === "abrir";
    return (
      <Card title={isAbrir ? "Abrir caja" : "Cerrar caja"}>
        <MontoForm
          label={isAbrir ? "Fondo inicial (ARS)" : "Efectivo contado (ARS)"}
          defaultValue={(!isAbrir && prefill.expectedCashAmount != null) ? String(prefill.expectedCashAmount) : "0"}
          onSubmit={doAction} onCancel={() => { setActionMode(null); setActionErr(null); }}
          submitting={actioning} errMsg={actionErr}
        />
        {!isAbrir && prefill.state === "OPEN" && (
          <p className="text-sm text-ink-soft">Efectivo esperado: {ars(prefill.expectedCashAmount)}</p>
        )}
      </Card>
    );
  }

  if (prefill.state === "NO_SESSION") {
    return (
      <Card title="Estado de caja">
        <div className="flex items-center justify-center rounded-control bg-surface-2 px-4 py-3 text-base text-ink-soft">Sin historial de caja</div>
        <p className="text-sm text-ink-soft">Aún no se registraron turnos en esta caja.</p>
        <PrimaryButton onClick={() => { setActionMode("abrir"); setActionErr(null); }}>Abrir caja</PrimaryButton>
      </Card>
    );
  }

  if (prefill.state === "CLOSED") {
    return (
      <Card title="Estado de caja">
        <section aria-label="Estado del turno" className="flex items-center justify-center rounded-control bg-surface-2 px-4 py-3 text-base font-semibold text-ink-soft">Cerrada</section>
        <dl className="flex flex-col gap-2 rounded-control bg-surface-2 px-4 py-3">
          <Row label="Cerrada" value={fmtDate(prefill.closedAt)} />
          <Row label="Efectivo contado" value={ars(prefill.closedCashAmount)} />
          {prefill.variance != null && (
            <Row label="Diferencia" value={
              <span style={prefill.variance !== 0 ? { color: "light-dark(#b91c1c, #f87171)" } : undefined}>{ars(prefill.variance)}</span>
            } />
          )}
        </dl>
        <PrimaryButton onClick={() => { setActionMode("abrir"); setActionErr(null); }}>Abrir caja</PrimaryButton>
      </Card>
    );
  }

  // OPEN state
  return (
    <Card title="Estado de caja">
      <section aria-label="Saldo actual" className="flex flex-col items-center gap-1 rounded-control bg-surface-2 px-4 py-4">
        <span className="text-sm text-ink-soft">Efectivo esperado</span>
        <span className="text-4xl font-bold text-ink">{ars(prefill.expectedCashAmount)}</span>
        <span className="mt-1 rounded-full px-3 py-1 text-sm font-medium"
          style={{ color: "light-dark(#117a3d, #4ade80)", background: "light-dark(#e7f6ec, #16331f)" }}>
          Turno abierto
        </span>
      </section>
      <dl className="flex flex-col gap-2 rounded-control bg-surface-2 px-4 py-3">
        <Row label="Abierta" value={fmtDate(prefill.openedAt)} />
        <Row label="Fondo inicial" value={ars(prefill.openedCashAmount)} />
        <Row label="Ingresos" value={ars(prefill.totalInflows)} />
        <Row label="Egresos" value={prefill.totalOutflows != null ? ars(-Math.abs(prefill.totalOutflows)) : "—"} />
        {prefill.movementCount != null && <Row label="Movimientos" value={String(prefill.movementCount)} />}
      </dl>
      <SecondaryButton onClick={() => { setActionMode("cerrar"); setActionErr(null); }}>Cerrar caja</SecondaryButton>
    </Card>
  );
}

const rootEl = document.getElementById("root");
if (rootEl) createRoot(rootEl).render(<CajaStatusWidget />);
