"use client";

// SetupChecklist — persistent setup card shown in the owner dashboard.
//
// Design rationale:
// - Stripe Incremental Onboarding (currently_due + eventually_due):
//   Each item is optional and completable at the owner's pace.
//   Source (verified HTTP 200):
//   https://docs.stripe.com/connect/custom/hosted-onboarding
// - Shopify Setup Guide composition — dedicated setup guide card, not inline:
//   "Give merchants the option to complete the onboarding at a later time."
//   Source (verified HTTP 200):
//   https://shopify.dev/docs/apps/design/user-experience/onboarding
// - NN/g progressive disclosure — surface items progressively, avoid walls of
//   options upfront:
//   https://www.nngroup.com/articles/progressive-disclosure/
// - Atlassian Onboarding — "Aim for 3-4 steps; people only need enough to get
//   started. Dismiss is critical."
//   https://atlassian.design/components/onboarding/
//
// Collapse/expand UX rationale:
// - Stripe Dashboard setup checklist, Shopify Home setup guide, Intercom Product
//   Tours — all use a collapsible card that persists minimized state so returning
//   users aren't blocked by a wall of onboarding on every visit.
//   Source: https://stripe.com/docs/dashboard/get-started (verified pattern)
//           https://www.intercom.com/blog/product-tours/
// - Collapsed state is persisted in localStorage (key: velora-setup-checklist-collapsed)
//   so it survives page reloads and Capacitor app restarts.
//   Default: expanded on first visit, then respects saved preference.
// - Pattern: button + conditional render — same mechanism as shadcn/ui Collapsible.
//   Source: https://ui.shadcn.com/docs/components/collapsible
//
// Completion detection uses BusinessCapabilities (loaded server-side from DB):
//   WhatsApp  → WabaConnection (whatsapp_business) OR whatsapp_phone
//   MP        → MpConnection (mercadopago)
//   Andreani  → CourierCredential provider="andreani" (andreani)
//   AFIP      → ArcaCredential (arca)
//   Stock     → Business.productCount > 0 (inferred from products array in
//               BusinessDataContext — not in BusinessCapabilities)
//
// Deep-link mechanism: each "Conectar" button navigates to the EXISTING connect
// flow via window.location.href. This reuses the same routes as the chat
// clientAction handlers (useAssistantStreaming.clientActions.ts) without
// duplicating logic.
//
// Helper types and pure functions live in SetupChecklist.helpers.ts.

import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import type { BusinessCapabilities } from "@/lib/business-capabilities";
import {
  readCollapsedFromStorage,
  writeCollapsedToStorage,
  readDismissedFromStorage,
  writeDismissedToStorage,
  buildChecklistItems,
  type ChecklistItem,
} from "./SetupChecklist.helpers";

// ── Props ─────────────────────────────────────────────────────────────────────

export interface SetupChecklistProps {
  capabilities: BusinessCapabilities;
  /** True when the business has at least 1 product loaded. */
  hasProducts: boolean;
  /** Navigate to a dashboard tab (for "Servicios" deep-links that stay in-app). */
  onNavigate: (tab: string) => void;
}

// ── Item renderer ─────────────────────────────────────────────────────────────

function ChecklistRow({ item }: { item: ChecklistItem }) {
  return (
    <li style={{ display: "flex", alignItems: "flex-start", gap: "0.75rem" }}>
      {/* Completion indicator */}
      <span
        aria-hidden="true"
        style={{
          flexShrink: 0,
          width: "1.25rem",
          height: "1.25rem",
          marginTop: "0.125rem",
          borderRadius: "50%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: item.done ? "var(--brand)" : "transparent",
          border: item.done ? "none" : "2px solid var(--tone-muted)",
        }}
      >
        {item.done && (
          <svg width="10" height="8" viewBox="0 0 10 8" fill="none" aria-hidden="true">
            <path d="M1 4L3.5 6.5L9 1" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </span>

      {/* Content */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.5rem", flexWrap: "wrap" }}>
          <span
            style={{
              fontFamily: "var(--font-dm-sans)",
              fontSize: "0.9375rem",
              fontWeight: 500,
              color: item.done ? "var(--tone-muted)" : "var(--tone-strong)",
              textDecoration: item.done ? "line-through" : "none",
            }}
          >
            {item.label}
          </span>

          {!item.done && (
            <Button
              variant="outline"
              size="sm"
              onClick={item.onAction}
              style={{ flexShrink: 0, fontSize: "0.8125rem" }}
            >
              {item.actionLabel}
            </Button>
          )}
        </div>

        {!item.done && (
          <p
            style={{
              fontFamily: "var(--font-dm-sans)",
              fontSize: "0.8125rem",
              color: "var(--tone-muted)",
              margin: "0.1875rem 0 0",
              lineHeight: 1.5,
            }}
          >
            {item.explain}
          </p>
        )}
      </div>
    </li>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

// eslint-disable-next-line max-lines-per-function -- render-only composition, not logic
export function SetupChecklist({ capabilities, hasProducts, onNavigate }: SetupChecklistProps) {
  const goToServicios = useCallback(() => onNavigate("servicios"), [onNavigate]);
  const goToMain = useCallback(() => onNavigate("main"), [onNavigate]);
  const items = buildChecklistItems(capabilities, hasProducts, goToServicios, goToMain);

  const nowItems = items.filter((i) => i.tier === "now");
  const laterItems = items.filter((i) => i.tier === "later");
  const allDone = items.every((i) => i.done);

  // Collapse state: initialized lazily from localStorage so it reflects the
  // owner's last choice on reload. Default false (expanded) on first visit.
  const [collapsed, setCollapsed] = useState<boolean>(() => readCollapsedFromStorage());

  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      writeCollapsedToStorage(next);
      return next;
    });
  }, []);

  // Dismiss = hide the card entirely (persisted). Explicit control per Atlassian
  // Onboarding ("Dismiss is critical"); the same hide-via-button pattern as the
  // Stripe/Shopify setup guides cited above.
  const [dismissed, setDismissed] = useState<boolean>(() => readDismissedFromStorage());
  const handleDismiss = useCallback(() => {
    setDismissed(true);
    writeDismissedToStorage(true);
  }, []);

  if (allDone || dismissed) return null;

  const doneCount = items.filter((i) => i.done).length;

  return (
    <section
      aria-label="Configuración de tu negocio"
      style={{
        background: "var(--surface)",
        border: "1px solid var(--surface-border, color-mix(in srgb, var(--tone-muted) 20%, transparent))",
        borderRadius: "var(--radius-md)",
        padding: collapsed ? "0.875rem 1.25rem" : "1.25rem",
        maxWidth: "44rem",
        width: "100%",
        margin: "0 auto 1rem auto",
        boxSizing: "border-box",
        transition: "padding 150ms ease",
      }}
    >
      {/* Header — always visible. Collapse toggle (chevron) lives here. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "0.5rem",
          marginBottom: collapsed ? 0 : "1rem",
        }}
      >
        <div style={{ minWidth: 0 }}>
          <h2
            style={{
              fontFamily: "var(--font-dm-sans)",
              fontSize: "1rem",
              fontWeight: 600,
              color: "var(--tone-strong)",
              margin: 0,
              lineHeight: 1.3,
            }}
          >
            Configuración del negocio
          </h2>
          <p
            style={{
              fontFamily: "var(--font-dm-sans)",
              fontSize: "0.875rem",
              color: "var(--tone-muted)",
              margin: "0.125rem 0 0",
              lineHeight: 1.5,
            }}
          >
            {doneCount} de {items.length} completados
            {collapsed && doneCount < items.length && (
              <span style={{ marginLeft: "0.375rem", color: "var(--brand)", fontWeight: 500 }}>
                · Tocá ▸ para ver los pasos
              </span>
            )}
          </p>
        </div>

        {/* Right controls: collapse (chevron) + dismiss (×). WCAG 2.5.5: 44×44px targets. */}
        <div style={{ display: "flex", alignItems: "center", gap: "0.125rem", flexShrink: 0 }}>
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-expanded={!collapsed}
            aria-controls="setup-checklist-body"
            aria-label={collapsed ? "Expandir configuración" : "Minimizar configuración"}
            style={{
              background: "transparent",
              border: "none",
              cursor: "pointer",
              padding: "0.5rem",
              minHeight: "44px",
              minWidth: "44px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: "var(--radius-sm, 0.375rem)",
              color: "var(--tone-muted)",
            }}
          >
            {/* Chevron — rotates 180° when expanded */}
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              aria-hidden="true"
              style={{
                transform: collapsed ? "rotate(0deg)" : "rotate(180deg)",
                transition: "transform 200ms ease",
              }}
            >
              <path
                d="M4 6L8 10L12 6"
                stroke="currentColor"
                strokeWidth="1.75"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>

          {/* Dismiss (×) — hides the card; persisted so it stays hidden. */}
          <button
            type="button"
            onClick={handleDismiss}
            aria-label="Ocultar configuración"
            style={{
              background: "transparent",
              border: "none",
              cursor: "pointer",
              padding: "0.5rem",
              minHeight: "44px",
              minWidth: "44px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: "var(--radius-sm, 0.375rem)",
              color: "var(--tone-muted)",
            }}
          >
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M4 4L12 12M12 4L4 12"
                stroke="currentColor"
                strokeWidth="1.75"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
      </div>

      {/* Checklist body — hidden when collapsed.
          Tier grouping: "now" items first (currently_due), then "later" (eventually_due).
          Source: https://docs.stripe.com/connect/custom/hosted-onboarding */}
      {!collapsed && (
        <div id="setup-checklist-body">
          {/* Tier: now — currently_due first steps */}
          <ul
            aria-label="Primeros pasos"
            role="list"
            style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "0.75rem" }}
          >
            {nowItems.map((item) => <ChecklistRow key={item.id} item={item} />)}
          </ul>

          {/* Tier: later — eventually_due integrations, shown with a light divider.
              All later items are rendered (done or not) to match now-tier behavior:
              completed items show struck-through, not hidden. Section is visible as
              long as the card itself is visible (allDone gate at top handles full completion). */}
          {laterItems.length > 0 && (
            <div style={{ marginTop: "1rem" }}>
              {/* h3: section heading under card h2 — announces tier to screen readers. */}
              <h3
                style={{
                  fontFamily: "var(--font-dm-sans)",
                  fontSize: "0.875rem",
                  fontWeight: 600,
                  letterSpacing: "0.06em",
                  textTransform: "uppercase",
                  color: "var(--tone-muted)",
                  margin: "0 0 0.625rem 0",
                  lineHeight: 1.3,
                }}
              >
                Cuando estés listo
              </h3>
              <ul
                aria-label="Integraciones opcionales"
                role="list"
                style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "0.75rem" }}
              >
                {laterItems.map((item) => <ChecklistRow key={item.id} item={item} />)}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
