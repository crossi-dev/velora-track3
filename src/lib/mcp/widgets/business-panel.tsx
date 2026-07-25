// business-panel.tsx — MCP App widget: ONE tool → ONE widget with FOUR client-side tabs.
//
// MCP Apps (SEP-1865, modelcontextprotocol/ext-apps) maps exactly one tool call to one
// widget — there is no supported way to render four separately-registered tools' widgets
// on the same screen. This widget renders four tabs (Cliente 360, Cerrar el día,
// Reposición de stock, Dashboard de ventas) from ONE prefill payload fetched by the
// single open_business_panel tool call — switching tabs is instant, client-side only,
// no extra tool round-trip.
//
// Design principles (same as the other Velora widgets):
//   - Native semantic elements, chameleon theming via useHostStyleVariables/useHostFonts.
//   - Typography: rem units, ≥ 0.875rem minimum.
//   - Brand accent (tab bar) uses real Velora navy/cream tokens (--color-brand,
//     --color-on-brand in widget.css) instead of the generic chameleon fallback, so the
//     brand identity persists across hosts — see the velora-design skill.
//
// Data contract: structuredContent.prefill from open_business_panel tool — see
// business-panel-render.ts for the exact shape.
//
// CSP: no allowUnsafeEval — do NOT add it without a CSP audit.

import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { useApp, useHostStyleVariables, useHostFonts } from "@modelcontextprotocol/ext-apps/react";
import { Centered, SecondaryButton } from "./_widget-primitives";

// ── Data contract (matches business-panel-render.ts) ─────────────────────────

type TabId = "cliente_360" | "cierre_dia" | "reposicion_stock" | "dashboard_ventas";

type CajaState = "OPEN" | "CLOSED" | "NO_SESSION";

interface CajaSummary {
  state: CajaState;
  expectedCashAmount?: number;
  closedCashAmount?: number | null;
}

interface VentasPeriodo {
  saleCount: number;
  totalRevenue: number;
  totalRevenueFormatted: string;
}

interface PendingSummary {
  id: string;
  customerName: string;
  totalARS: number;
  itemCount: number;
  createdAt: string;
}

interface LowStockItem {
  id: string;
  name: string;
  stock: number;
  reorderThreshold: number;
}

interface SupplierItem {
  id: string;
  name: string;
  phone: string | null;
  contactName: string | null;
}

interface PurchaseRequestItem {
  id: string;
  requestNumber: string;
  issuedAt: string;
  totalAmount: number;
  currency: string;
  supplierName: string | null;
}

interface Margen {
  revenueFormatted: string;
  costFormatted: string;
  marginFormatted: string;
  marginPercent: number;
  costCoverage: string;
}

interface RankingEntry {
  rank: number;
  product: string;
  unitsSold: number;
}

interface PorEmpleadoEntry {
  employee: string;
  saleCount: number;
  totalRevenueFormatted: string;
}

interface HistorialOrder {
  date: string;
  total: string;
  items: Array<{ product: string; qty: number }>;
}

interface HistorialCliente {
  lifetimeOrderCount: number;
  lifetimeTotalSpent: string;
  recentOrders: HistorialOrder[];
}

type Cliente360Data =
  | { status: "empty" }
  | { status: "not_found"; query: string }
  | { status: "ambiguous"; query: string; matches: string[] }
  | {
      status: "found";
      customer: { name: string; phone: string | null; email: string | null; address: string | null; city: string | null };
      historial: HistorialCliente | null;
      pendingOrders: PendingSummary[];
    };

interface Prefill {
  defaultTab: TabId;
  cliente360: Cliente360Data;
  cierreDia: { caja: CajaSummary; ventasHoy: VentasPeriodo; pendingOrders: PendingSummary[]; pendingCount: number };
  reposicionStock: { lowStock: LowStockItem[]; suppliers: SupplierItem[]; purchaseRequests: PurchaseRequestItem[] };
  dashboardVentas: { margen: Margen | null; ranking: RankingEntry[]; porEmpleado: PorEmpleadoEntry[] };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const TAB_ORDER: TabId[] = ["cliente_360", "cierre_dia", "reposicion_stock", "dashboard_ventas"];
const TAB_LABELS: Record<TabId, string> = {
  cliente_360: "Cliente 360",
  cierre_dia: "Cerrar el día",
  reposicion_stock: "Reposición de stock",
  dashboard_ventas: "Dashboard de ventas",
};

const ars = (n: number | null | undefined) =>
  n != null && Number.isFinite(n)
    ? "$ " + n.toLocaleString("es-AR", { minimumFractionDigits: 0, maximumFractionDigits: 2 })
    : "—";

function cajaChipLabel(state: CajaState): string {
  if (state === "OPEN") return "Turno abierto";
  if (state === "CLOSED") return "Caja cerrada";
  return "Sin turno";
}

// ── Presentational primitives (local — mirror business-overview.tsx's SectionCard) ──

function SectionCard({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <section className="flex flex-col gap-2 rounded-control bg-surface-2 p-4">
      <h2 className="text-sm font-semibold text-ink-soft">{title}</h2>
      {children}
    </section>
  );
}

/** Inline Velora mark (crossi-dev/velora public/velora-mark.svg) — every Velora
 *  product carries the mark, even sub-products. No external asset load (CSP-safe). */
function VeloraMark(): React.JSX.Element {
  return (
    <svg width="24" height="24" viewBox="0 0 64 64" fill="none" role="img" aria-label="Velora">
      <rect x="4" y="4" width="56" height="56" rx="14" fill="#1B3A6B" />
      <path d="M20 44V20M20 44L44 20M44 20V34" stroke="#FAF6EE" strokeWidth="8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ── Tabs ──────────────────────────────────────────────────────────────────────

function ClienteTab({
  data,
  query,
  onQueryChange,
  onSearch,
}: {
  data: Cliente360Data;
  query: string;
  onQueryChange: (v: string) => void;
  onSearch: () => void;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      {data.status !== "found" && (
        <SectionCard title="Buscar cliente">
          <div className="flex gap-2">
            <input
              type="text"
              value={query}
              onChange={(e) => onQueryChange(e.target.value)}
              placeholder="Nombre del cliente"
              className="min-w-0 flex-1 rounded-control border border-line bg-surface px-3 py-2 text-base text-ink"
            />
            <button
              type="button"
              onClick={onSearch}
              className="shrink-0 rounded-control bg-brand px-4 py-2 text-base font-semibold text-on-brand"
            >
              Buscar
            </button>
          </div>
          {data.status === "not_found" && <p className="text-sm text-danger-ink">No encontramos a “{data.query}”.</p>}
          {data.status === "ambiguous" && (
            <p className="text-sm text-ink-soft">
              Varios clientes coinciden con “{data.query}”: {data.matches.join(", ")}. Escribí el nombre completo.
            </p>
          )}
          {data.status === "empty" && (
            <p className="text-sm text-ink-soft">Buscá un cliente para ver su historial, cobros pendientes y contacto.</p>
          )}
        </SectionCard>
      )}

      {data.status === "found" && (
        <>
          <SectionCard title={data.customer.name}>
            <dl className="flex flex-col gap-1 text-sm">
              {data.customer.phone && (
                <div className="flex justify-between gap-2">
                  <dt className="text-ink-soft">WhatsApp</dt>
                  <dd className="text-ink">{data.customer.phone}</dd>
                </div>
              )}
              {data.customer.email && (
                <div className="flex justify-between gap-2">
                  <dt className="text-ink-soft">Email</dt>
                  <dd className="truncate text-ink">{data.customer.email}</dd>
                </div>
              )}
              {data.customer.address && (
                <div className="flex justify-between gap-2">
                  <dt className="text-ink-soft">Dirección</dt>
                  <dd className="truncate text-ink">
                    {data.customer.address}
                    {data.customer.city ? `, ${data.customer.city}` : ""}
                  </dd>
                </div>
              )}
              {!data.customer.phone && !data.customer.email && !data.customer.address && (
                <p className="text-ink-soft">Sin datos de contacto cargados.</p>
              )}
            </dl>
          </SectionCard>

          <SectionCard title="Historial de compras">
            {data.historial ? (
              <>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm text-ink-soft">
                    {data.historial.lifetimeOrderCount} compra{data.historial.lifetimeOrderCount !== 1 ? "s" : ""} en total
                  </span>
                  <span className="text-base font-semibold text-ink">{data.historial.lifetimeTotalSpent}</span>
                </div>
                {data.historial.recentOrders.length > 0 ? (
                  <ul className="flex flex-col gap-2">
                    {data.historial.recentOrders.map((o, idx) => (
                      <li key={idx} className="rounded-control bg-surface p-3">
                        <div className="flex items-center justify-between gap-2 text-sm">
                          <span className="text-ink-soft">{o.date}</span>
                          <span className="font-medium text-ink">{o.total}</span>
                        </div>
                        <div className="mt-1 truncate text-sm text-ink-soft">
                          {o.items.map((it) => `${it.qty}× ${it.product}`).join(", ")}
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-ink-soft">Sin compras registradas.</p>
                )}
              </>
            ) : (
              <p className="text-sm text-ink-soft">No pudimos cargar el historial.</p>
            )}
          </SectionCard>

          <SectionCard title="Cobros pendientes">
            {data.pendingOrders.length === 0 ? (
              <p className="text-sm text-ink-soft">Sin cobros pendientes.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {data.pendingOrders.map((po) => (
                  <li key={po.id} className="flex items-center justify-between gap-2 rounded-control bg-surface p-3">
                    <span className="text-sm text-ink">
                      {po.itemCount} ítem{po.itemCount !== 1 ? "s" : ""}
                    </span>
                    <span className="text-sm font-medium text-ink">{ars(po.totalARS)}</span>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>
        </>
      )}
    </div>
  );
}

function CierreDiaTab({
  data,
  onOpenCaja,
  onOpenPending,
}: {
  data: Prefill["cierreDia"];
  onOpenCaja: () => void;
  onOpenPending: () => void;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      <SectionCard title="Caja">
        <div className="flex items-center justify-between gap-2">
          <span
            className="rounded-full px-3 py-1 text-sm font-medium"
            style={
              data.caja.state === "OPEN"
                ? { color: "light-dark(#117a3d, #4ade80)", background: "light-dark(#e7f6ec, #16331f)" }
                : { color: "light-dark(#6b6b6b, #a0a0a5)", background: "light-dark(#ececec, #2c2c2e)" }
            }
          >
            {cajaChipLabel(data.caja.state)}
          </span>
          {data.caja.state === "OPEN" && <span className="text-lg font-bold text-ink">{ars(data.caja.expectedCashAmount)}</span>}
          {data.caja.state === "CLOSED" && <span className="text-lg font-bold text-ink">{ars(data.caja.closedCashAmount)}</span>}
        </div>
        <SecondaryButton onClick={onOpenCaja}>Ver / cerrar caja</SecondaryButton>
      </SectionCard>

      <SectionCard title="Ventas de hoy">
        <div className="flex items-center justify-between gap-2">
          <span className="text-2xl font-bold text-ink">{data.ventasHoy.saleCount}</span>
          <span className="text-sm text-ink-soft">venta{data.ventasHoy.saleCount !== 1 ? "s" : ""}</span>
        </div>
        <div className="text-base font-semibold text-ink">{data.ventasHoy.totalRevenueFormatted}</div>
      </SectionCard>

      <SectionCard title="Cobros pendientes">
        <div className="flex items-center justify-between gap-2">
          <span className="text-2xl font-bold text-ink">{data.pendingCount}</span>
          <span className="text-sm text-ink-soft">{data.pendingCount === 0 ? "Sin cobros pendientes" : "esperando pago"}</span>
        </div>
        {data.pendingCount > 0 && <SecondaryButton onClick={onOpenPending}>Ver cobros pendientes</SecondaryButton>}
      </SectionCard>
    </div>
  );
}

function StockTab({ data }: { data: Prefill["reposicionStock"] }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      <SectionCard title="Stock bajo">
        {data.lowStock.length === 0 ? (
          <p className="text-sm text-ink-soft">Todo el stock está por encima del mínimo.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {data.lowStock.map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-2">
                <span className="text-sm text-ink">{p.name}</span>
                <span className="rounded-full border border-line bg-surface px-2 py-0.5 text-sm text-danger-ink">
                  {p.stock} / {p.reorderThreshold}
                </span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <SectionCard title="Proveedores">
        {data.suppliers.length === 0 ? (
          <p className="text-sm text-ink-soft">Sin proveedores cargados.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {data.suppliers.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-2">
                <span className="text-sm text-ink">{s.name}</span>
                <span className="text-sm text-ink-soft">{s.phone ?? s.contactName ?? "—"}</span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <SectionCard title="Solicitudes de compra recientes">
        {data.purchaseRequests.length === 0 ? (
          <p className="text-sm text-ink-soft">Sin solicitudes de compra registradas.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {data.purchaseRequests.map((pr) => (
              <li key={pr.id} className="flex items-center justify-between gap-2 rounded-control bg-surface p-3">
                <div className="min-w-0">
                  <div className="truncate text-sm text-ink">
                    {pr.requestNumber}
                    {pr.supplierName ? ` · ${pr.supplierName}` : ""}
                  </div>
                  <div className="text-sm text-ink-soft">{new Date(pr.issuedAt).toLocaleDateString("es-AR")}</div>
                </div>
                <span className="shrink-0 text-sm font-medium text-ink">{ars(pr.totalAmount)}</span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}

function DashboardTab({ data }: { data: Prefill["dashboardVentas"] }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      <SectionCard title="Margen del mes">
        {data.margen ? (
          <>
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm text-ink-soft">Ingresos</span>
              <span className="text-sm font-medium text-ink">{data.margen.revenueFormatted}</span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm text-ink-soft">Costo</span>
              <span className="text-sm font-medium text-ink">{data.margen.costFormatted}</span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm text-ink-soft">Margen</span>
              <span className="text-base font-semibold text-ink">
                {data.margen.marginFormatted} ({data.margen.marginPercent}%)
              </span>
            </div>
            <p className="text-sm text-ink-soft">{data.margen.costCoverage}</p>
          </>
        ) : (
          <p className="text-sm text-ink-soft">Sin ventas este mes.</p>
        )}
      </SectionCard>

      <SectionCard title="Ranking de productos">
        {data.ranking.length === 0 ? (
          <p className="text-sm text-ink-soft">Sin ventas este mes.</p>
        ) : (
          <ol className="flex flex-col gap-2">
            {data.ranking.map((r) => (
              <li key={r.rank} className="flex items-center justify-between gap-2">
                <span className="text-sm text-ink">
                  #{r.rank} {r.product}
                </span>
                <span className="text-sm text-ink-soft">{r.unitsSold} u.</span>
              </li>
            ))}
          </ol>
        )}
      </SectionCard>

      <SectionCard title="Ventas por empleado">
        {data.porEmpleado.length === 0 ? (
          <p className="text-sm text-ink-soft">Sin ventas este mes.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {data.porEmpleado.map((e) => (
              <li key={e.employee} className="flex items-center justify-between gap-2">
                <span className="text-sm text-ink">{e.employee}</span>
                <span className="text-sm text-ink-soft">
                  {e.totalRevenueFormatted} ({e.saleCount})
                </span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}

// ── Main widget ───────────────────────────────────────────────────────────────

function BusinessPanelWidget(): React.JSX.Element {
  const { app, isConnected, error } = useApp({ appInfo: { name: "business-panel", version: "1.0.0" }, capabilities: {} });
  useHostStyleVariables(app, app?.getHostContext());
  useHostFonts(app, app?.getHostContext());

  const [prefill, setPrefill] = useState<Prefill | null>(null);
  const [received, setReceived] = useState(false);
  const [activeTab, setActiveTab] = useState<TabId | null>(null);
  const [navError, setNavError] = useState<string | null>(null);
  const [clienteQuery, setClienteQuery] = useState("");

  useEffect(() => {
    if (!app) return;
    app.ontoolresult = (params) => {
      setReceived(true);
      const raw = (params.structuredContent ?? params.arguments ?? {}) as { prefill?: Prefill } & Prefill;
      const data = (raw.prefill ?? raw) as Prefill;
      setPrefill(data);
      setActiveTab(data.defaultTab);
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

  async function searchCliente() {
    if (!app || !clienteQuery.trim()) return;
    setNavError(null);
    await app
      .callServerTool({ name: "open_business_panel", arguments: { customerName: clienteQuery.trim(), defaultTab: "cliente_360" } })
      .catch(() => setNavError("No se pudo buscar el cliente. Intentá de nuevo."));
  }

  if (error) return <Centered>No pudimos abrir el panel del negocio. {error.message}</Centered>;
  if (!isConnected) return <Centered>Conectando…</Centered>;
  if (!prefill && received) return <Centered>No pudimos cargar el panel. Probá de nuevo.</Centered>;
  if (!prefill || !activeTab) return <Centered>Cargando panel del negocio…</Centered>;

  return (
    <main className="mx-auto flex max-w-md flex-col gap-4 p-5 text-ink">
      <header className="flex items-center gap-2">
        <VeloraMark />
        <h1 className="text-xl font-semibold leading-snug">Panel del negocio</h1>
      </header>

      <nav aria-label="Secciones" className="flex gap-1 overflow-x-auto rounded-control bg-surface-2 p-1">
        {TAB_ORDER.map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setActiveTab(tab)}
            aria-current={activeTab === tab ? "page" : undefined}
            className={
              "shrink-0 rounded-control px-3 py-2 text-sm font-medium transition-colors " +
              (activeTab === tab ? "bg-brand text-on-brand" : "text-ink-soft")
            }
          >
            {TAB_LABELS[tab]}
          </button>
        ))}
      </nav>

      {activeTab === "cliente_360" && (
        <ClienteTab data={prefill.cliente360} query={clienteQuery} onQueryChange={setClienteQuery} onSearch={searchCliente} />
      )}
      {activeTab === "cierre_dia" && (
        <CierreDiaTab data={prefill.cierreDia} onOpenCaja={openCajaStatus} onOpenPending={openPendingOrders} />
      )}
      {activeTab === "reposicion_stock" && <StockTab data={prefill.reposicionStock} />}
      {activeTab === "dashboard_ventas" && <DashboardTab data={prefill.dashboardVentas} />}

      {navError && (
        <p className="text-sm text-danger-ink" role="alert">
          {navError}
        </p>
      )}
    </main>
  );
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

const rootEl = document.getElementById("root");
if (rootEl) createRoot(rootEl).render(<BusinessPanelWidget />);
