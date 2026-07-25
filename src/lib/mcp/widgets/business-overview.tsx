// business-overview.tsx — MCP App widget for the owner's business dashboard.
//
// ONE tool → ONE widget, two display modes (per the official MCP Apps Design
// Guidelines: claude.com/docs/connectors/building/mcp-apps/design-guidelines —
// "Start simple. Reveal complexity only when users need it. The inline card might
// show a summary; fullscreen mode can offer the detailed view."):
//   - inline (default): a compact snapshot — 4 data points (caja, ventas, cobros
//     pendientes, stock bajo) and 2 actions at the bottom (Ver caja, Ver panel
//     completo), per the doc's inline-card limits ("Max data points: 4-5",
//     "Max actions: 2, placed at the bottom of the card").
//   - fullscreen: four tabs — Cliente 360, Cerrar el día, Reposición de stock,
//     Dashboard de ventas — using tabs as fullscreen's documented disclosure
//     pattern ("collapsible sidebars, tabs, or pagination"). Full lists (low
//     stock items, cobros detail) live here, not inline.
// Both modes render from the SAME prefill (one tool call fetches everything up
// front), so expanding to fullscreen is instant — no second round trip.
//
// Real API, verified against the installed SDK (not guessed):
//   useApp({ appInfo, capabilities: { availableDisplayModes: ["inline","fullscreen"] } })
//   app.requestDisplayMode({ mode }) → { mode: "inline"|"fullscreen"|"pip" }
// (node_modules/@modelcontextprotocol/ext-apps/dist/src/app.d.ts)
//
// Design principles (same as the other Velora widgets):
//   - Native semantic elements, chameleon theming via useHostStyleVariables/useHostFonts.
//   - Status colors go through StatusChip (_widget-primitives.tsx), which resolves
//     the host's --color-background-success/--color-text-success tokens — never a
//     hardcoded hex, per the doc's "Never hardcode colors" rule.
//   - Touch targets: min-h-11 (44px) on every tappable control, per the doc's
//     44x44pt minimum.
//   - Brand accent (tab bar) uses real Velora navy/cream tokens (--color-brand,
//     --color-on-brand in widget.css) instead of the generic chameleon fallback —
//     explicitly allowed by the doc for "accents and identity."
//   - Tab bar: equal-width flex items, not horizontal-scroll — a 4th tab hidden
//     behind silent overflow-x-auto with no scroll affordance is a real mobile bug
//     (flagged in review); wrapping to two rows on narrow viewports instead.
//
// Data contract: structuredContent.prefill from open_business_overview tool — see
// business-overview-render.ts for the exact shape.
//
// CSP: no allowUnsafeEval — do NOT add it without a CSP audit.

import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { useApp, useHostStyleVariables, useHostFonts } from "@modelcontextprotocol/ext-apps/react";
import { Centered, SecondaryButton, StatusChip } from "./_widget-primitives";

// ── Data contract (matches business-overview-render.ts) ─────────────────────────

type TabId = "cliente_360" | "cierre_dia" | "reposicion_stock" | "dashboard_ventas";
type CajaState = "OPEN" | "CLOSED" | "NO_SESSION";

interface CajaSummary {
  state: CajaState;
  expectedCashAmount?: number;
  openedAt?: string;
  closedAt?: string | null;
  closedCashAmount?: number | null;
}

interface VentasPeriodo {
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

interface PendingSummary {
  id: string;
  customerName: string;
  totalARS: number;
  itemCount: number;
  createdAt: string;
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
  startInFullscreen: boolean;
  defaultTab: TabId;
  summary: {
    caja: CajaSummary;
    ventasHoy: VentasPeriodo;
    ventasSemana: VentasPeriodo;
    pendingCount: number;
    lowStock: LowStockItem[];
  };
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
  reposicion_stock: "Reposición",
  dashboard_ventas: "Dashboard",
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

function SectionCard({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <section className="flex flex-col gap-2 rounded-control bg-surface-2 p-4">
      <h2 className="text-sm font-semibold text-ink-soft">{title}</h2>
      {children}
    </section>
  );
}

/** Inline Velora mark (crossi-dev/velora public/velora-mark.svg) — every Velora
 *  product carries the mark. No external asset load (CSP-safe). */
function VeloraMark(): React.JSX.Element {
  return (
    <svg width="24" height="24" viewBox="0 0 64 64" fill="none" role="img" aria-label="Velora">
      <rect x="4" y="4" width="56" height="56" rx="14" fill="#1B3A6B" />
      <path d="M20 44V20M20 44L44 20M44 20V34" stroke="#FAF6EE" strokeWidth="8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ── Inline summary ────────────────────────────────────────────────────────────
// Doc constraints (claude.com/docs/.../design-guidelines#inline-card):
// "Max data points: 4-5" and "Max actions: 2, placed at the bottom of the card."
// 4 sections (caja, ventas, cobros pendientes, stock bajo) + 2 actions at the
// bottom (Ver caja, Ver panel completo). Full lists (low-stock items, cobros
// detail) live in fullscreen's tabs, not inline.

function InlineSummary({
  data,
  onOpenCaja,
  onExpand,
  canExpand,
}: {
  data: Prefill["summary"];
  onOpenCaja: () => void;
  onExpand: () => void;
  canExpand: boolean;
}): React.JSX.Element {
  return (
    <>
      <SectionCard title="Caja">
        <div className="flex items-center justify-between gap-2">
          <StatusChip tone={data.caja.state === "OPEN" ? "success" : "neutral"}>{cajaChipLabel(data.caja.state)}</StatusChip>
          {data.caja.state === "OPEN" && <span className="text-lg font-bold text-ink">{ars(data.caja.expectedCashAmount)}</span>}
          {data.caja.state === "CLOSED" && <span className="text-lg font-bold text-ink">{ars(data.caja.closedCashAmount)}</span>}
        </div>
      </SectionCard>

      <SectionCard title="Ventas">
        <div className="flex items-center justify-between gap-2">
          <dt className="text-sm text-ink-soft">Hoy</dt>
          <dd className="text-sm font-medium text-ink">
            {data.ventasHoy.saleCount} venta{data.ventasHoy.saleCount !== 1 ? "s" : ""} · {data.ventasHoy.totalRevenueFormatted || ars(data.ventasHoy.totalRevenue)}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-2">
          <dt className="text-sm text-ink-soft">Esta semana</dt>
          <dd className="text-sm font-medium text-ink">
            {data.ventasSemana.saleCount} venta{data.ventasSemana.saleCount !== 1 ? "s" : ""} · {data.ventasSemana.totalRevenueFormatted || ars(data.ventasSemana.totalRevenue)}
          </dd>
        </div>
      </SectionCard>

      <SectionCard title="Cobros pendientes">
        <div className="flex items-center justify-between gap-2">
          <span className="text-2xl font-bold text-ink">{data.pendingCount}</span>
          <span className="text-sm text-ink-soft">{data.pendingCount === 0 ? "Sin cobros pendientes" : "esperando pago"}</span>
        </div>
      </SectionCard>

      <SectionCard title="Stock bajo">
        <div className="flex items-center justify-between gap-2">
          <span className="text-2xl font-bold text-ink">{data.lowStock.length}</span>
          <span className="text-sm text-ink-soft">{data.lowStock.length === 0 ? "todo por encima del mínimo" : "producto(s) bajo mínimo"}</span>
        </div>
      </SectionCard>

      <div className="flex gap-2">
        <button
          type="button"
          onClick={onOpenCaja}
          className="min-h-11 flex-1 rounded-control border border-line bg-surface px-4 text-base text-ink"
        >
          Ver caja
        </button>
        {canExpand && (
          <button
            type="button"
            onClick={onExpand}
            className="min-h-11 flex-1 rounded-control bg-brand px-4 text-base font-semibold text-on-brand"
          >
            Ver panel completo
          </button>
        )}
      </div>
    </>
  );
}

// ── Fullscreen tabs ───────────────────────────────────────────────────────────

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
          {data.status === "not_found" && <p className="text-sm text-danger-ink">No encontramos a &ldquo;{data.query}&rdquo;.</p>}
          {data.status === "ambiguous" && (
            <p className="text-sm text-ink-soft">
              Varios clientes coinciden con &ldquo;{data.query}&rdquo;: {data.matches.join(", ")}. Escribí el nombre completo.
            </p>
          )}
          {data.status === "empty" && <p className="text-sm text-ink-soft">Buscá un cliente para ver su historial, cobros pendientes y contacto.</p>}
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
              {!data.customer.phone && !data.customer.email && !data.customer.address && <p className="text-ink-soft">Sin datos de contacto cargados.</p>}
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
                        <div className="mt-1 truncate text-sm text-ink-soft">{o.items.map((it) => `${it.qty}× ${it.product}`).join(", ")}</div>
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
          <StatusChip tone={data.caja.state === "OPEN" ? "success" : "neutral"}>{cajaChipLabel(data.caja.state)}</StatusChip>
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

function BusinessOverviewWidget(): React.JSX.Element {
  const { app, isConnected, error } = useApp({
    appInfo: { name: "business-overview", version: "1.0.0" },
    capabilities: { availableDisplayModes: ["inline", "fullscreen"] },
  });
  useHostStyleVariables(app, app?.getHostContext());
  useHostFonts(app, app?.getHostContext());

  const [prefill, setPrefill] = useState<Prefill | null>(null);
  const [received, setReceived] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [activeTab, setActiveTab] = useState<TabId>("cierre_dia");
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
      if (data.startInFullscreen) setFullscreen(true);
    };
  }, [app]);

  // Sync local fullscreen state if the host changes display mode from outside
  // (e.g. user backs out via the host's own chrome, not our button).
  useEffect(() => {
    if (!app) return;
    const ctx = app.getHostContext();
    if (ctx?.displayMode) setFullscreen(ctx.displayMode === "fullscreen");
  }, [app]);

  async function requestFullscreen(next: boolean) {
    if (!app) return;
    const ctx = app.getHostContext();
    const targetMode = next ? "fullscreen" : "inline";
    if (!ctx?.availableDisplayModes?.includes(targetMode)) {
      // Host doesn't support fullscreen (e.g. some non-Claude-mobile hosts) —
      // fall back to rendering the tabs inline rather than a dead button.
      setFullscreen(next);
      return;
    }
    const result = await app.requestDisplayMode({ mode: targetMode }).catch(() => null);
    setFullscreen(result ? result.mode === "fullscreen" : next);
  }

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
      .callServerTool({ name: "open_business_overview", arguments: { customerName: clienteQuery.trim(), defaultTab: "cliente_360" } })
      .catch(() => setNavError("No se pudo buscar el cliente. Intentá de nuevo."));
  }

  if (error) return <Centered>No pudimos abrir el resumen del negocio. {error.message}</Centered>;
  if (!isConnected) return <Centered>Conectando…</Centered>;
  if (!prefill && received) return <Centered>No pudimos cargar el resumen. Probá de nuevo.</Centered>;
  if (!prefill) return <Centered>Cargando resumen del negocio…</Centered>;

  return (
    <main className="mx-auto flex max-w-md flex-col gap-4 p-5 text-ink">
      {fullscreen ? (
        <>
          <header className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <VeloraMark />
              <h1 className="text-xl font-semibold leading-snug">Panel del negocio</h1>
            </div>
            <button
              type="button"
              onClick={() => requestFullscreen(false)}
              className="min-h-11 shrink-0 rounded-control border border-line bg-surface px-4 text-sm text-ink"
            >
              Resumen
            </button>
          </header>

          {/* Equal-width tabs that wrap on narrow viewports — no hidden overflow. */}
          <nav aria-label="Secciones" className="flex flex-wrap gap-1 rounded-control bg-surface-2 p-1">
            {TAB_ORDER.map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => setActiveTab(tab)}
                aria-current={activeTab === tab ? "page" : undefined}
                className={
                  "min-h-11 min-w-[45%] flex-1 rounded-control px-2 text-sm font-medium transition-colors " +
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
          {activeTab === "cierre_dia" && <CierreDiaTab data={prefill.cierreDia} onOpenCaja={openCajaStatus} onOpenPending={openPendingOrders} />}
          {activeTab === "reposicion_stock" && <StockTab data={prefill.reposicionStock} />}
          {activeTab === "dashboard_ventas" && <DashboardTab data={prefill.dashboardVentas} />}
        </>
      ) : (
        <>
          <h1 className="text-xl font-semibold leading-snug">Resumen del negocio</h1>
          <InlineSummary
            data={prefill.summary}
            onOpenCaja={openCajaStatus}
            onExpand={() => requestFullscreen(true)}
            canExpand
          />
        </>
      )}

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
if (rootEl) createRoot(rootEl).render(<BusinessOverviewWidget />);
