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

import React, { useEffect, useState, useRef } from "react";
import { createRoot } from "react-dom/client";
import { useApp, useHostStyleVariables, useHostFonts } from "@modelcontextprotocol/ext-apps/react";
import { Centered, SecondaryButton, StatusChip, SupersededNotice, VeloraMark } from "./_widget-primitives";

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
  /** true when this section failed to load server-side — render "no pudimos
   * cargar" instead of a confident (and possibly false) "0 ventas". */
  failed?: boolean;
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
  createdAt: number;
  /** Monotonic per-process tie-breaker for createdAt collisions (same-ms calls) —
   * claude.com/docs/connectors/building/mcp-apps/instance-supersession. */
  seq?: number;
  startInFullscreen: boolean;
  defaultTab: TabId;
  summary: {
    caja: CajaSummary;
    ventasHoy: VentasPeriodo;
    ventasSemana: VentasPeriodo;
    pendingCount: number;
    pendingTotalARS: number;
    lowStock: LowStockItem[];
    topLowStockName: string | null;
    fiscalReady: boolean;
    marginPercentMonth: number | null;
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

function ventasLabel(v: VentasPeriodo): string {
  if (v.failed) return "no pudimos cargar";
  // JD finding (2026-07-26): a bare "0 ventas · $ 0,00" reads as alarming on the
  // single most emotionally-loaded card — every sibling card (Cobros, Stock)
  // already frames its zero state with words instead of a flat number. This
  // mirrors that: honest (no sales yet), not falsely upbeat.
  if (v.saleCount === 0) return "Sin ventas por ahora";
  return `${v.saleCount} venta${v.saleCount !== 1 ? "s" : ""} · ${v.totalRevenueFormatted || ars(v.totalRevenue)}`;
}

function cajaChipLabel(state: CajaState): string {
  if (state === "OPEN") return "Turno abierto";
  if (state === "CLOSED") return "Caja cerrada";
  return "Sin turno";
}

/** hero=true marks the ONE card the owner's eye should land on first (the caja
 *  balance) with a brand-accent left border — uses --color-brand, the same
 *  allowed "accent and identity" carve-out as the tab bar, not a new token. */
function SectionCard({ title, children, hero }: { title: string; children: React.ReactNode; hero?: boolean }): React.JSX.Element {
  return (
    <section className={`flex flex-col gap-2 rounded-control bg-surface-2 p-4 ${hero ? "border-l-4 border-brand" : ""}`}>
      <h2 className="text-sm font-semibold text-ink-soft">{title}</h2>
      {children}
    </section>
  );
}

/** Matches InlineSummary's shape (4 SectionCards + 1 action) so the loading →
 * loaded transition doesn't jump — per the doc's mobile loading-states guidance:
 * "Show skeleton screens... match the layout structure... avoid spinners for
 * inline content." Replaces the old plain "Cargando…" text. */
function InlineSkeleton(): React.JSX.Element {
  return (
    <main className="mx-auto flex max-w-md flex-col gap-4 p-5" aria-busy="true" aria-label="Cargando resumen del negocio">
      <div className="h-6 w-40 animate-pulse rounded-control bg-surface-2" />
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="flex h-16 flex-col justify-center gap-2 rounded-control bg-surface-2 p-4">
          <div className="h-3 w-20 animate-pulse rounded-full bg-surface" />
          <div className="h-4 w-32 animate-pulse rounded-full bg-surface" />
        </div>
      ))}
      <div className="h-11 w-full animate-pulse rounded-control bg-surface-2" />
    </main>
  );
}

// ── Inline summary ────────────────────────────────────────────────────────────
// Doc constraints (claude.com/docs/.../design-guidelines#inline-card):
// "Max data points: 4-5" and "Max actions: 2, placed at the bottom of the card."
// 4 sections (caja, ventas, cobros pendientes, stock bajo) + 1 action at the
// bottom (Ver panel completo, defaults to the Cerrar el día tab — no separate
// "Ver caja" jump, since that used to swap this widget out for open_caja_status
// and strand the owner with no way back; the balance is already shown inline).
// Full lists (low-stock items, cobros detail) live in fullscreen's tabs.

function InlineSummary({
  data,
  onExpand,
  canExpand,
}: {
  data: Prefill["summary"];
  onExpand: () => void;
  canExpand: boolean;
}): React.JSX.Element {
  return (
    <>
      <SectionCard title="Caja" hero>
        <div className="flex items-center justify-between gap-2">
          <StatusChip tone={data.caja.state === "OPEN" ? "success" : "neutral"}>{cajaChipLabel(data.caja.state)}</StatusChip>
          {data.caja.state === "OPEN" && <span className="text-lg font-bold tabular-nums text-ink">{ars(data.caja.expectedCashAmount)}</span>}
          {data.caja.state === "CLOSED" && <span className="text-lg font-bold tabular-nums text-ink">{ars(data.caja.closedCashAmount)}</span>}
        </div>
        {/* JD integration-map finding (2026-07-26): fiscal setup was invisible on the
         * main dashboard — the owner only found out invoicing wasn't ready by asking
         * explicitly. Stays silent when ready, per the same "clean when nothing's
         * wrong" principle Cobros/Stock already follow. */}
        {!data.fiscalReady && (
          <p className="mt-2 text-sm text-danger-ink">
            ⚠ Facturación electrónica sin configurar — pedime "cómo activo la facturación" para completarla.
          </p>
        )}
      </SectionCard>

      <SectionCard title="Ventas">
        <div className="flex items-center justify-between gap-2">
          <dt className="text-sm text-ink-soft">Hoy</dt>
          <dd className={`text-sm font-medium tabular-nums ${data.ventasHoy.failed ? "text-danger-ink" : "text-ink"}`}>{ventasLabel(data.ventasHoy)}</dd>
        </div>
        <div className="flex items-center justify-between gap-2">
          <dt className="text-sm text-ink-soft">Esta semana</dt>
          <dd className={`text-sm font-medium tabular-nums ${data.ventasSemana.failed ? "text-danger-ink" : "text-ink"}`}>{ventasLabel(data.ventasSemana)}</dd>
        </div>
        {/* JD integration-map finding (2026-07-26): margin data was already fetched
         * for the Dashboard tab (3 taps deep) and never surfaced inline. */}
        {data.marginPercentMonth != null && (
          <div className="flex items-center justify-between gap-2">
            <dt className="text-sm text-ink-soft">Margen del mes</dt>
            <dd className="text-sm font-medium tabular-nums text-ink">{data.marginPercentMonth.toFixed(0)}%</dd>
          </div>
        )}
      </SectionCard>

      <SectionCard title="Cobros pendientes">
        <div className="flex items-center justify-between gap-2">
          <span className="text-2xl font-bold tabular-nums text-ink">{data.pendingCount}</span>
          <span className={`text-sm ${data.pendingCount === 0 ? "text-success-ink" : "text-ink-soft"}`}>
            {data.pendingCount === 0 ? "Al día, sin nada pendiente" : "esperando pago"}
          </span>
        </div>
        {/* JD finding (2026-07-26): the count alone can't answer "how much" —
         * pendingTotalARS was already fetched for the fullscreen tab, just not
         * surfaced here. One extra line, still one data point (the card's theme
         * stays "cobros pendientes"), well under the doc's 4-5 data point cap. */}
        {data.pendingCount > 0 && (
          <div className="text-sm font-medium tabular-nums text-ink-soft">{ars(data.pendingTotalARS)} en total</div>
        )}
      </SectionCard>

      <SectionCard title="Stock bajo">
        <div className="flex items-center justify-between gap-2">
          <span className="text-2xl font-bold tabular-nums text-ink">{data.lowStock.length}</span>
          <span className={`text-sm ${data.lowStock.length === 0 ? "text-success-ink" : "text-ink-soft"}`}>
            {data.lowStock.length === 0 ? "Todo por encima del mínimo" : "producto(s) bajo mínimo"}
          </span>
        </div>
        {/* JD finding (2026-07-26): "4 productos" doesn't say which ones — the
         * name was already in the payload. Naming the most urgent one (list is
         * ordered by the backend) turns a count into something actionable
         * without a tap, same one-data-point budget as above. */}
        {data.topLowStockName && (
          <div className="truncate text-sm font-medium text-ink-soft">
            {data.topLowStockName}
            {data.lowStock.length > 1 ? ` y ${data.lowStock.length - 1} más` : ""}
          </div>
        )}
      </SectionCard>

      {canExpand && (
        <button
          type="button"
          onClick={onExpand}
          className="min-h-11 w-full rounded-control bg-brand px-4 text-base font-semibold text-on-brand"
        >
          Ver panel completo
        </button>
      )}
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
                  <span className="text-base font-semibold tabular-nums text-ink">{data.historial.lifetimeTotalSpent}</span>
                </div>
                {data.historial.recentOrders.length > 0 ? (
                  <ul className="flex flex-col gap-2">
                    {data.historial.recentOrders.map((o, idx) => (
                      <li key={idx} className="rounded-control bg-surface p-3">
                        <div className="flex items-center justify-between gap-2 text-sm">
                          <span className="text-ink-soft">{o.date}</span>
                          <span className="font-medium tabular-nums text-ink">{o.total}</span>
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
                    <span className="text-sm font-medium tabular-nums text-ink">{ars(po.totalARS)}</span>
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
      <SectionCard title="Caja" hero>
        <div className="flex items-center justify-between gap-2">
          <StatusChip tone={data.caja.state === "OPEN" ? "success" : "neutral"}>{cajaChipLabel(data.caja.state)}</StatusChip>
          {data.caja.state === "OPEN" && <span className="text-lg font-bold tabular-nums text-ink">{ars(data.caja.expectedCashAmount)}</span>}
          {data.caja.state === "CLOSED" && <span className="text-lg font-bold tabular-nums text-ink">{ars(data.caja.closedCashAmount)}</span>}
        </div>
        <SecondaryButton onClick={onOpenCaja}>Ver / cerrar caja</SecondaryButton>
      </SectionCard>

      <SectionCard title="Ventas de hoy">
        {data.ventasHoy.failed ? (
          <p className="text-sm text-danger-ink">No pudimos cargar las ventas de hoy.</p>
        ) : (
          <>
            <div className="flex items-center justify-between gap-2">
              <span className="text-2xl font-bold tabular-nums text-ink">{data.ventasHoy.saleCount}</span>
              <span className="text-sm text-ink-soft">venta{data.ventasHoy.saleCount !== 1 ? "s" : ""}</span>
            </div>
            <div className="text-base font-semibold tabular-nums text-ink">{data.ventasHoy.totalRevenueFormatted}</div>
          </>
        )}
      </SectionCard>

      <SectionCard title="Cobros pendientes">
        <div className="flex items-center justify-between gap-2">
          <span className="text-2xl font-bold tabular-nums text-ink">{data.pendingCount}</span>
          <span className={`text-sm ${data.pendingCount === 0 ? "text-success-ink" : "text-ink-soft"}`}>
            {data.pendingCount === 0 ? "Al día, sin nada pendiente" : "esperando pago"}
          </span>
        </div>
        {data.pendingCount > 0 && <SecondaryButton onClick={onOpenPending}>Ver cobros pendientes</SecondaryButton>}
      </SectionCard>
    </div>
  );
}

function StockTab({
  data,
  onRequestRestock,
}: {
  data: Prefill["reposicionStock"];
  onRequestRestock: (productName: string) => void;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      <SectionCard title="Stock bajo">
        {data.lowStock.length === 0 ? (
          <p className="text-sm text-ink-soft">Todo el stock está por encima del mínimo.</p>
        ) : (
          <>
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
            <SecondaryButton onClick={() => onRequestRestock(data.lowStock[0].name)}>
              Pedir reposición de {data.lowStock[0].name}
            </SecondaryButton>
          </>
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
                <span className="shrink-0 text-sm font-medium tabular-nums text-ink">{ars(pr.totalAmount)}</span>
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
              <span className="text-sm font-medium tabular-nums text-ink">{data.margen.revenueFormatted}</span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm text-ink-soft">Costo</span>
              <span className="text-sm font-medium tabular-nums text-ink">{data.margen.costFormatted}</span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm text-ink-soft">Margen</span>
              <span className="text-base font-semibold tabular-nums text-ink">
                {data.margen.marginFormatted} ({data.margen.marginPercent}%)
              </span>
            </div>
            <p className="text-sm text-ink-soft">{data.margen.costCoverage}</p>
          </>
        ) : (
          <p className="text-sm text-ink-soft">Todavía no hay ventas este mes para calcular margen.</p>
        )}
      </SectionCard>

      <SectionCard title="Ranking de productos">
        {data.ranking.length === 0 ? (
          <p className="text-sm text-ink-soft">Ningún producto vendido todavía este mes.</p>
        ) : (
          <ol className="flex flex-col gap-2">
            {data.ranking.map((r) => (
              <li key={r.rank} className="flex items-center justify-between gap-2">
                <span className="text-sm text-ink">
                  #{r.rank} {r.product}
                </span>
                <span className="text-sm tabular-nums text-ink-soft">{r.unitsSold} u.</span>
              </li>
            ))}
          </ol>
        )}
      </SectionCard>

      <SectionCard title="Ventas por empleado">
        {data.porEmpleado.length === 0 ? (
          <p className="text-sm text-ink-soft">Sin ventas repartidas por empleado todavía este mes.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {data.porEmpleado.map((e) => (
              <li key={e.employee} className="flex items-center justify-between gap-2">
                <span className="text-sm text-ink">{e.employee}</span>
                <span className="text-sm tabular-nums text-ink-soft">
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
  const [superseded, setSuperseded] = useState(false);

  // Widget instance supersession (claude.com/docs/connectors/building/mcp-apps/
  // instance-supersession) — this is a dashboard, the doc's textbook case: if the
  // owner re-asks "veamos mi negocio" mid-conversation, only the newest copy of
  // this widget should stay interactive. Older copies gray out instead of both
  // silently feeding stale reads back into Claude's context. Channel is scoped
  // per-conversation by default (no fixed _meta.ui.domain set on this resource).
  const instanceIdRef = useRef<string>(crypto.randomUUID());
  const orderKeyRef = useRef<number | undefined>(undefined);
  const seqRef = useRef<number | undefined>(undefined);
  const keyFinalizedRef = useRef(false);
  const channelRef = useRef<BroadcastChannel | null>(null);
  const peersRef = useRef(new Map<string, { orderKey: number; seq?: number; instanceId: string }>());

  useEffect(() => {
    const channel = new BroadcastChannel("velora-business-overview-supersede");
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
    app.ontoolresult = (params) => {
      setReceived(true);
      const raw = (params.structuredContent ?? params.arguments ?? {}) as { prefill?: Prefill } & Prefill;
      const data = (raw.prefill ?? raw) as Prefill;
      setPrefill(data);
      setActiveTab(data.defaultTab);
      if (data.startInFullscreen) setFullscreen(true);
      if (Number.isFinite(data.createdAt)) {
        orderKeyRef.current = data.createdAt;
        seqRef.current = Number.isFinite(data.seq) ? data.seq : undefined;
        keyFinalizedRef.current = true;
        announceInstance();
      }
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

  // Chaining into a DIFFERENT widget via a direct callServerTool from inside
  // this one was live-confirmed to succeed server-side but never render a
  // new widget (docs/TODO-widget-initiated-tool-call-no-render.md). Prefer
  // app.sendMessage (posts as if the owner typed it, so Claude processes it
  // as a real turn and calls the tool itself — Claude-initiated calls render
  // correctly). Falls back to the direct call on hosts without the `message`
  // capability. Confirmed working live 2026-07-27 for the same pattern in
  // catalog-selector.tsx.
  async function openCajaStatus() {
    if (!app || superseded) return;
    setNavError(null);
    if (app.getHostCapabilities()?.message) {
      await app.sendMessage({ role: "user", content: [{ type: "text", text: "Mostrame el estado de la caja." }] })
        .catch(() => setNavError("No se pudo abrir el estado de caja. Intentá de nuevo."));
      return;
    }
    await app.callServerTool({ name: "open_caja_status", arguments: {} }).catch(() => {
      setNavError("No se pudo abrir el estado de caja. Intentá de nuevo.");
    });
  }

  async function openPendingOrders() {
    if (!app || superseded) return;
    setNavError(null);
    if (app.getHostCapabilities()?.message) {
      await app.sendMessage({ role: "user", content: [{ type: "text", text: "Mostrame los cobros pendientes." }] })
        .catch(() => setNavError("No se pudieron abrir los cobros pendientes. Intentá de nuevo."));
      return;
    }
    await app.callServerTool({ name: "open_pending_orders", arguments: {} }).catch(() => {
      setNavError("No se pudieron abrir los cobros pendientes. Intentá de nuevo.");
    });
  }

  // JD integration-map finding (2026-07-26): "Reposición" was pure-informational,
  // no way to act on a low-stock alert without leaving the widget. create_purchase_request
  // needs a supplier + unit price the low-stock payload doesn't carry, so a blind
  // one-tap mutation isn't safe here — this pushes a suggested message to chat instead
  // (app.sendMessage, the documented pattern for "benefits from Claude's interpretation"),
  // letting Claude ask for supplier/price rather than guessing them.
  async function requestRestock(productName: string) {
    if (!app || superseded) return;
    setNavError(null);
    await app.sendMessage({
      role: "user",
      content: [{ type: "text", text: `Necesito pedir reposición de ${productName}.` }],
    }).catch(() => {
      setNavError("No se pudo enviar el pedido de reposición. Intentá de nuevo.");
    });
  }

  async function searchCliente() {
    if (!app || superseded || !clienteQuery.trim()) return;
    setNavError(null);
    await app
      .callServerTool({ name: "open_business_overview", arguments: { customerName: clienteQuery.trim(), defaultTab: "cliente_360" } })
      .catch(() => setNavError("No se pudo buscar el cliente. Intentá de nuevo."));
  }

  async function retryLoad() {
    if (!app) return;
    setReceived(false);
    await app.callServerTool({ name: "open_business_overview", arguments: {} }).catch(() => setReceived(true));
  }

  if (error) return <Centered>No pudimos abrir el resumen del negocio. {error.message}</Centered>;
  if (!isConnected) return <Centered>Conectando…</Centered>;
  if (!prefill && received) {
    return (
      <Centered>
        No pudimos cargar el resumen del negocio.
        <button type="button" onClick={retryLoad} className="mt-3 min-h-11 w-full rounded-control bg-brand px-4 text-base font-semibold text-on-brand">
          Reintentar
        </button>
      </Centered>
    );
  }
  if (!prefill) return <InlineSkeleton />;

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
    <main className="mx-auto flex max-w-md flex-col gap-4 p-5 text-ink" style={safeAreaStyle}>
      {superseded && <SupersededNotice />}
      {fullscreen ? (
        <>
          <header className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <VeloraMark />
              <h1 className="text-xl font-semibold leading-snug">Tu negocio, en detalle</h1>
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
          {activeTab === "reposicion_stock" && (
            <StockTab data={prefill.reposicionStock} onRequestRestock={requestRestock} />
          )}
          {activeTab === "dashboard_ventas" && <DashboardTab data={prefill.dashboardVentas} />}
        </>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <VeloraMark size={20} />
            <h1 className="text-xl font-semibold leading-snug">Tu negocio, al día</h1>
          </div>
          <InlineSummary data={prefill.summary} onExpand={() => requestFullscreen(true)} canExpand />
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
