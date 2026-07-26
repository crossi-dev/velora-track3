// onboarding.tsx — MCP App widget: connection hub "Conectá tu negocio".
//
// READ-ONLY — this widget never calls a mutating tool.
// It shows the business's integration status (7 integrations) and offers
// launcher buttons that open Velora's official connect/import pages in
// the browser via app.openLink.
//
// Design principles (industry-sourced):
//   - Status rows with connected / not-connected chips (green check / neutral).
//   - One primary CTA per not-connected row (OpenAI Apps SDK guideline: no dead ends).
//   - Action buttons call app.openLink({ url }) — URL comes from integration.connectUrl.
//   - Native semantic elements: <main>, <ul>, <li> (W3C First Rule of ARIA).
//   - Chameleon theming via ext-apps useHostStyleVariables/useHostFonts.
//   - Typography: rem units, ≥ 0.875rem minimum per 2026 CSS standards.
//
// Data contract: structuredContent.prefill = { integrations: IntegrationStatus[], baseUrl: string }
// where IntegrationStatus = { key, label, connected, missing, guidance, connectUrl, connectMethod }
//
// openLink: the HOST must declare openLinks capability in its AppBridge. The app
// widget has no control over this — app.openLink() returns { isError: true } if
// the host denies or doesn't support it. Handled gracefully (no crash).
//
// Button → URL mapping (per-row, driven by integration.connectUrl):
//   Each not-connected integration row shows "Conectar {label}" → integration.connectUrl
//   "Subir foto de stock"   → baseUrl + /dashboard              (camera/photo-extract)
//   "Subir archivo de stock"→ baseUrl + /dashboard?tab=inventario (xlsx/csv import)
//
// Honesty constraint: Meta Embedded Signup not fully implemented.
//   WhatsApp button deep-links to dashboard — no claim of a full signup flow here.
//
// CSP: no allowUnsafeEval — do NOT add it without a CSP audit.

import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { useApp, useHostStyleVariables, useHostFonts } from "@modelcontextprotocol/ext-apps/react";
import { Centered, StatusChip, StatusBanner, VeloraMark } from "./_widget-primitives";

// ── Types ─────────────────────────────────────────────────────────────────────

interface IntegrationStatus {
  key: string;
  label: string;
  connected: boolean;
  missing: string[];
  guidance: string;
  connectUrl: string;
  connectMethod: "oauth" | "form";
}

interface Prefill {
  integrations: IntegrationStatus[];
  baseUrl: string;
}

// ── Stock upload buttons (always visible, independent of integration status) ──

interface StockActionDef {
  key: string;
  label: string;
  path: string;
}

const STOCK_ACTIONS: StockActionDef[] = [
  { key: "upload-photo", label: "Subir foto de stock", path: "/dashboard" },
  { key: "upload-file", label: "Subir archivo de stock", path: "/dashboard?tab=inventario" },
];

// The guidance copy (connection-tools.ts) is authored for the AI agent and ends
// with "Entrá acá: <url>". In-widget each row already carries its own Conectar
// button, so we surface only the WHY (the reason), not the redundant raw URL.
function guidanceReason(guidance: string): string {
  const marker = guidance.indexOf("Entrá acá:");
  return (marker === -1 ? guidance : guidance.slice(0, marker)).trim();
}

// ── Main widget ───────────────────────────────────────────────────────────────

function OnboardingHub(): React.JSX.Element {
  const { app, isConnected, error } = useApp({
    appInfo: { name: "onboarding", version: "1.0.0" },
    // capabilities: {} — app capabilities (McpUiAppCapabilities).
    // openLinks is a HOST capability declared in AppBridge, not here.
    capabilities: {},
  });
  useHostStyleVariables(app, app?.getHostContext());
  useHostFonts(app, app?.getHostContext());

  const [prefill, setPrefill] = useState<Prefill | null>(null);
  const [toolResultReceived, setToolResultReceived] = useState(false);
  const [openLinkError, setOpenLinkError] = useState<string | null>(null);

  useEffect(() => {
    if (!app) return;
    // Render data arrives ONLY via ontoolresult (structuredContent).
    // ontoolinput is intentionally NOT wired: carries raw INPUT args, no resolved fields.
    const apply = (params: { structuredContent?: unknown; arguments?: unknown }) => {
      // Mark that a result was received regardless of whether it's usable.
      // This distinguishes "still waiting" from "result arrived but unusable"
      // so we can show an error state instead of infinite "Cargando…".
      setToolResultReceived(true);
      const raw = (params.structuredContent ?? params.arguments ?? {}) as { prefill?: Prefill } & Prefill;
      const args = (raw.prefill ?? raw) as Prefill;
      if (args.integrations && args.baseUrl !== undefined) {
        setPrefill(args);
      }
    };
    app.ontoolresult = (params) => apply(params);
  }, [app]);

  async function handleOpenLink(url: string) {
    if (!app || !prefill) return;
    const result = await app.openLink({ url });
    if (result?.isError) {
      // Host denied or doesn't support openLink — show the URL for manual copy.
      setOpenLinkError(url);
    }
  }

  if (error) {
    return <Centered>No pudimos abrir el panel de conexiones. {error.message}</Centered>;
  }
  if (!isConnected) return <Centered>Conectando…</Centered>;
  // If a tool result arrived but carried no valid integrations payload (e.g.
  // open_onboarding returned isError:true), show an actionable error instead of
  // hanging on "Cargando…" forever.
  if (!prefill && toolResultReceived) {
    return <Centered>No pudimos cargar el estado de tus integraciones. Probá de nuevo.</Centered>;
  }
  if (!prefill) return <Centered>Cargando estado de integraciones…</Centered>;

  const { integrations } = prefill;
  const connectedCount = integrations.filter((i) => i.connected).length;
  const pendingIntegrations = integrations.filter((i) => !i.connected && i.connectUrl);

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

  return (
    <main className="mx-auto flex max-w-md flex-col gap-4 p-5 text-ink" style={safeAreaStyle}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <VeloraMark size={20} />
          <h1 className="text-xl font-semibold leading-snug">Conectá tu negocio</h1>
        </div>
        <span className="shrink-0 rounded-full border border-line bg-surface-2 px-3 py-1 text-sm font-medium text-ink-soft">
          {connectedCount}/{integrations.length}
        </span>
      </div>

      {/* Integration status list — each pending row includes its own connect CTA */}
      <ul className="flex flex-col gap-2" aria-label="Estado de integraciones">
        {integrations.map((item) => (
          <li
            key={item.key}
            className="flex flex-col gap-2 rounded-control bg-surface-2 px-4 py-3"
          >
            <div className="flex items-center justify-between gap-3">
              <span className="text-base text-ink">{item.label}</span>
              {item.connected ? (
                <span aria-label="Conectado" className="shrink-0">
                  <StatusChip tone="success">
                    <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12" fill="currentColor" className="mr-1">
                      <path d="M10 3L5 8.5 2 5.5l-.7.7 3.7 3.7 5.7-5.7L10 3z" />
                    </svg>
                    Conectado
                  </StatusChip>
                </span>
              ) : item.connectUrl ? (
                <button
                  type="button"
                  onClick={() => handleOpenLink(item.connectUrl)}
                  // min-h-[44px]: touch-target minimum (same convention as the
                  // quantity inputs in catalog-selector.tsx). Focus/hover/motion
                  // classes mirror _widget-primitives.tsx's shared INTERACTIVE +
                  // SecondaryButton hover treatment so this row action behaves
                  // like every other button in the Velora widgets.
                  className="flex min-h-[44px] shrink-0 items-center justify-center rounded-control border border-line bg-surface px-4 py-2 text-sm font-medium text-ink transition-[background-color,border-color,opacity,transform] duration-[var(--widget-duration)] ease-[var(--widget-ease)] hover:bg-surface-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent active:scale-[0.98]"
                >
                  Conectar
                </button>
              ) : (
                <span className="shrink-0 text-sm font-medium text-ink-soft">Sin conectar</span>
              )}
            </div>
            {/* Guidance note — the WHY behind connecting this service. Only
             * pending rows carry non-empty guidance (connected rows return ""). */}
            {!item.connected && guidanceReason(item.guidance) && (
              <p className="text-sm text-ink-soft">{guidanceReason(item.guidance)}</p>
            )}
          </li>
        ))}
      </ul>

      {/* Stock upload buttons — always visible */}
      <section aria-label="Importar catálogo">
        <div className="flex flex-col gap-2">
          {STOCK_ACTIONS.map((action) => (
            <button
              key={action.key}
              type="button"
              onClick={() => handleOpenLink(prefill.baseUrl + action.path)}
              className="w-full rounded-control border border-line bg-surface px-4 py-3 text-base font-medium text-ink"
            >
              {action.label}
            </button>
          ))}
        </div>
      </section>

      {/* Pending integrations summary — shown only when some are not yet connected */}
      {pendingIntegrations.length > 0 && (
        <p className="text-sm text-ink-soft">
          {pendingIntegrations.length === 1
            ? "Completá la conexión pendiente para operar con toda la potencia de Velora."
            : `Tenés ${pendingIntegrations.length} integraciones pendientes. Completalas para operar con toda la potencia de Velora.`}
        </p>
      )}

      {/* openLink fallback — show URL if host denied */}
      {openLinkError && (
        <div
          role="alert"
          className="rounded-control border border-line bg-surface-2 p-3 text-sm text-ink-soft"
        >
          No pudimos abrir el enlace automáticamente. Copialo y pegalo en tu navegador:
          <br />
          <span className="break-all text-ink">{openLinkError}</span>
        </div>
      )}

      {/* All connected state */}
      {connectedCount === integrations.length && (
        <StatusBanner tone="success">
          ¡Todo conectado! Ya podés operar: probá pedirme &apos;vendí 2 alfajores a Juan&apos; para
          registrar tu primera venta, o &apos;mostrame mi negocio&apos; para ver el resumen.
        </StatusBanner>
      )}
    </main>
  );
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

const rootEl = document.getElementById("root");
if (rootEl) createRoot(rootEl).render(<OnboardingHub />);
