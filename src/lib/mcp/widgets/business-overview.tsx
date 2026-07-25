// business-overview.tsx — MCP App widget for the owner's "front door" business snapshot.
//
// READ-ONLY dashboard aggregating four existing read paths into one screen:
//   - caja balance + shift status      (same resolution as open_caja_status)
//   - today's / this week's sales      (same data as query_sales)
//   - pending cobros count             (same data as open_pending_orders)
//   - low-stock products               (same data as query_catalog's stock field,
//                                        filtered by Product.reorderThreshold)
//
// This widget never calls a mutating server tool directly — it only offers
// navigation hops to the existing read-only widgets (open_caja_status,
// open_pending_orders), which is the same hop pattern pending-orders.tsx uses
// to jump to cobro-status.
//
// Design principles (same as the other Velora widgets):
//   - Native semantic elements, chameleon theming via useHostStyleVariables/useHostFonts.
//   - Typography: rem units, ≥ 0.875rem minimum.
//
// Data contract: structuredContent.prefill from open_business_overview tool.
//   caja: { state: "OPEN"|"CLOSED"|"NO_SESSION", expectedCashAmount?, openedAt?, closedAt?, closedCashAmount? }
//   ventasHoy / ventasSemana: { saleCount, totalRevenue, totalRevenueFormatted }
//   pendingCount: number
//   lowStock: Array<{ id, name, stock, reorderThreshold }>
//
// CSP: no allowUnsafeEval — do NOT add it without a CSP audit.

import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { useApp, useHostStyleVariables, useHostFonts } from "@modelcontextprotocol/ext-apps/react";
import { Centered } from "./_widget-primitives";

type CajaState = "OPEN" | "CLOSED" | "NO_SESSION";

interface CajaSummary {
  state: CajaState;
  expectedCashAmount?: number;
  openedAt?: string;
  closedAt?: string | null;
  closedCashAmount?: number | null;
}

interface SalesSummary {
  saleCount: number;
  totalRevenue: number;
  totalRevenueFormatted: string;
}

interface LowStockItem {
  id: string;
  name: string;
  stock: number;
  reorderThreshold: number;
}

interface Prefill {
  caja: CajaSummary;
  ventasHoy: SalesSummary;
  ventasSemana: SalesSummary;
  pendingCount: number;
  lowStock: LowStockItem[];
}

const LOW_STOCK_DISPLAY_CAP = 10;

const ars = (n: number | null | undefined) =>
  n != null && Number.isFinite(n)
    ? "$ " + n.toLocaleString("es-AR", { minimumFractionDigits: 0, maximumFractionDigits: 2 })
    : "—";

function cajaChipLabel(state: CajaState): string {
  if (state === "OPEN") return "Turno abierto";
  if (state === "CLOSED") return "Caja cerrada";
  return "Sin turno";
}

function SectionCard({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <section className="flex flex-col gap-2 rounded-control bg-surface-2 p-4">
      <h2 className="text-sm font-semibold text-ink-soft">{title}</h2>
      {children}
    </section>
  );
}

function BusinessOverviewWidget(): React.JSX.Element {
  const { app, isConnected, error } = useApp({ appInfo: { name: "business-overview", version: "1.0.0" }, capabilities: {} });
  useHostStyleVariables(app, app?.getHostContext());
  useHostFonts(app, app?.getHostContext());

  const [prefill, setPrefill] = useState<Prefill | null>(null);
  const [received, setReceived] = useState(false);
  const [navError, setNavError] = useState<string | null>(null);

  useEffect(() => {
    if (!app) return;
    app.ontoolresult = (params) => {
      setReceived(true);
      const raw = (params.structuredContent ?? params.arguments ?? {}) as { prefill?: Prefill } & Prefill;
      setPrefill((raw.prefill ?? raw) as Prefill);
    };
  }, [app]);

  async function openCajaStatus() {
    if (!app) return;
    setNavError(null);
    await app.callServerTool({ name: "open_caja_status", arguments: {} }).catch(() => {
      setNavError("No se pudo abrir el estado de caja. Intentá de nuevo.");
    });
  }

  async function openPendingOrders() {
    if (!app) return;
    setNavError(null);
    await app.callServerTool({ name: "open_pending_orders", arguments: {} }).catch(() => {
      setNavError("No se pudieron abrir los cobros pendientes. Intentá de nuevo.");
    });
  }

  if (error) return <Centered>No pudimos abrir el resumen del negocio. {error.message}</Centered>;
  if (!isConnected) return <Centered>Conectando…</Centered>;
  if (!prefill && received) return <Centered>No pudimos cargar el resumen. Probá de nuevo.</Centered>;
  if (!prefill) return <Centered>Cargando resumen del negocio…</Centered>;

  const lowStockDisplayed = prefill.lowStock.slice(0, LOW_STOCK_DISPLAY_CAP);
  const lowStockOverflow = prefill.lowStock.length - lowStockDisplayed.length;

  return (
    <main className="mx-auto flex max-w-md flex-col gap-4 p-5 text-ink">
      <h1 className="text-xl font-semibold leading-snug">Resumen del negocio</h1>

      {/* Caja */}
      <SectionCard title="Caja">
        <div className="flex items-center justify-between gap-2">
          <span className="rounded-full px-3 py-1 text-sm font-medium"
            style={
              prefill.caja.state === "OPEN"
                ? { color: "light-dark(#117a3d, #4ade80)", background: "light-dark(#e7f6ec, #16331f)" }
                : { color: "light-dark(#6b6b6b, #a0a0a5)", background: "light-dark(#ececec, #2c2c2e)" }
            }
          >
            {cajaChipLabel(prefill.caja.state)}
          </span>
          {prefill.caja.state === "OPEN" && (
            <span className="text-lg font-bold text-ink">{ars(prefill.caja.expectedCashAmount)}</span>
          )}
          {prefill.caja.state === "CLOSED" && (
            <span className="text-lg font-bold text-ink">{ars(prefill.caja.closedCashAmount)}</span>
          )}
        </div>
        <button
          type="button"
          onClick={openCajaStatus}
          className="w-full rounded-control border border-line bg-surface px-4 py-2 text-base text-ink"
        >
          Ver caja
        </button>
      </SectionCard>

      {/* Ventas */}
      <SectionCard title="Ventas">
        <div className="flex items-center justify-between gap-2">
          <dt className="text-sm text-ink-soft">Hoy</dt>
          <dd className="text-sm font-medium text-ink">
            {prefill.ventasHoy.saleCount} venta{prefill.ventasHoy.saleCount !== 1 ? "s" : ""} · {prefill.ventasHoy.totalRevenueFormatted || ars(prefill.ventasHoy.totalRevenue)}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-2">
          <dt className="text-sm text-ink-soft">Esta semana</dt>
          <dd className="text-sm font-medium text-ink">
            {prefill.ventasSemana.saleCount} venta{prefill.ventasSemana.saleCount !== 1 ? "s" : ""} · {prefill.ventasSemana.totalRevenueFormatted || ars(prefill.ventasSemana.totalRevenue)}
          </dd>
        </div>
      </SectionCard>

      {/* Cobros pendientes */}
      <SectionCard title="Cobros pendientes">
        <div className="flex items-center justify-between gap-2">
          <span className="text-2xl font-bold text-ink">{prefill.pendingCount}</span>
          <span className="text-sm text-ink-soft">
            {prefill.pendingCount === 0 ? "Sin cobros pendientes" : "esperando pago"}
          </span>
        </div>
        {prefill.pendingCount > 0 && (
          <button
            type="button"
            onClick={openPendingOrders}
            className="w-full rounded-control border border-line bg-surface px-4 py-2 text-base text-ink"
          >
            Ver cobros pendientes
          </button>
        )}
      </SectionCard>

      {/* Stock bajo */}
      <SectionCard title="Stock bajo">
        {lowStockDisplayed.length === 0 ? (
          <p className="text-sm text-ink-soft">Todo el stock está por encima del mínimo.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {lowStockDisplayed.map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-2">
                <span className="text-sm text-ink">{p.name}</span>
                <span className="rounded-full border border-line bg-surface px-2 py-0.5 text-sm text-danger-ink">
                  {p.stock} / {p.reorderThreshold}
                </span>
              </li>
            ))}
          </ul>
        )}
        {lowStockOverflow > 0 && (
          <p className="text-sm text-ink-soft">y {lowStockOverflow} producto{lowStockOverflow !== 1 ? "s" : ""} más</p>
        )}
      </SectionCard>

      {navError && <p className="text-sm text-danger-ink">{navError}</p>}
    </main>
  );
}

const rootEl = document.getElementById("root");
if (rootEl) createRoot(rootEl).render(<BusinessOverviewWidget />);
