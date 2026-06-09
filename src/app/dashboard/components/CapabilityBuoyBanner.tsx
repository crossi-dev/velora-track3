"use client";

// CapabilityBuoyBanner — contextual next-best-step nudge for the dashboard.
//
// Pull Revelation pattern (NNGroup): triggered by presence of missing capability,
// not by a timer or page load. Shows EXACTLY ONE suggestion — never a menu.
//
// Sources:
// - Pull Revelation (signal-triggered help):
//   https://www.nngroup.com/articles/onboarding-tutorials/
//   "Pull revelations — help content triggered by some signal that the user
//    would benefit from that information at that moment"
// - One topic per turn:
//   https://www.intercom.com/blog/onboarding-guide/
//   "Stick to one main topic/feature/issue per tour"
// - Dismiss per Atlassian ("dismissible is critical"):
//   https://atlassian.design/components/onboarding/
//   "Aim for 3-4 steps as a maximum — people only need enough to get started"
// - Material Design Empty States (rather than leaving users on blank screen):
//   https://m3.material.io/components/cards/guidelines
//   "Rather than leaving users on a blank screen, the UI should encourage interaction"

import { useCallback, useEffect, useState } from "react";
import type { BusinessCapabilities } from "@/lib/business-capabilities";

// ── Snooze persistence ────────────────────────────────────────────────────────

const SNOOZE_KEY = "velora:capability-buoy:snoozed-until";
const SNOOZE_MS = 24 * 60 * 60 * 1000; // 24 hours per Atlassian dismiss pattern

function isSnoozed(): boolean {
  try {
    const raw = localStorage.getItem(SNOOZE_KEY);
    if (!raw) return false;
    return Date.now() < Number(raw);
  } catch {
    return false;
  }
}

function snooze(): void {
  try {
    localStorage.setItem(SNOOZE_KEY, String(Date.now() + SNOOZE_MS));
  } catch {
    // localStorage unavailable (SSR, private mode) — fail silently.
  }
}

// ── Next-best-step heuristic ──────────────────────────────────────────────────
//
// Mirrors the buoy contract in ONBOARDING_AGENT_PROMPT — single source of
// truth for the heuristic order. Changes here must be reflected in the prompt.

interface NextBestStep {
  /** Short label shown in the banner. */
  label: string;
  /** Which tab to navigate to when the owner clicks the CTA. */
  targetTab: string;
}

function computeNextBestStep(caps: BusinessCapabilities): NextBestStep | null {
  if (!caps.mercadopago) {
    return { label: "Conectá Mercado Pago para cobrar con QR y links de pago.", targetTab: "servicios" };
  }
  if (!caps.whatsapp_phone && !caps.whatsapp_business) {
    return { label: "Conectá tu número de WhatsApp Business para recibir pedidos.", targetTab: "servicios" };
  }
  if (!caps.arca) {
    return { label: "Conectá ARCA/AFIP para emitir facturas oficiales.", targetTab: "servicios" };
  }
  if (!caps.andreani) {
    return { label: "Conectá Andreani para cotizar y crear envíos.", targetTab: "servicios" };
  }
  // All key capabilities connected — nothing to surface.
  return null;
}

// ── Component ─────────────────────────────────────────────────────────────────

interface CapabilityBuoyBannerProps {
  /** Capabilities loaded server-side or from the services-status endpoint. */
  capabilities: BusinessCapabilities;
  /** Callback to change the active dashboard tab (e.g. navigate to "servicios"). */
  onNavigate: (tab: string) => void;
}

export function CapabilityBuoyBanner({ capabilities, onNavigate }: CapabilityBuoyBannerProps) {
  const [visible, setVisible] = useState(false);

  // Evaluate snooze client-side only (localStorage is not available on server).
  useEffect(() => {
    if (!isSnoozed()) setVisible(true);
  }, []);

  const nextStep = computeNextBestStep(capabilities);

  const handleDismiss = useCallback(() => {
    snooze();
    setVisible(false);
  }, []);

  const handleAction = useCallback(() => {
    if (nextStep) onNavigate(nextStep.targetTab);
  }, [nextStep, onNavigate]);

  if (!visible || !nextStep) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "space-between",
        gap: "0.75rem",
        padding: "0.875rem 1rem",
        background: "var(--brand-soft)",
        borderLeft: "3px solid var(--brand)",
        borderRadius: "var(--radius-md)",
        marginBottom: "0.75rem",
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{
          margin: 0,
          fontFamily: "var(--font-dm-sans)",
          fontSize: "0.875rem",
          color: "var(--tone-body)",
          lineHeight: 1.5,
        }}>
          {nextStep.label}
        </p>
        <button
          type="button"
          onClick={handleAction}
          style={{
            marginTop: "0.5rem",
            fontSize: "0.875rem",
            fontWeight: 600,
            color: "var(--brand)",
            background: "none",
            border: "none",
            padding: 0,
            cursor: "pointer",
            textDecoration: "underline",
            textUnderlineOffset: "2px",
          }}
        >
          Configurar ahora
        </button>
      </div>

      {/* Dismiss X — per NNGroup: "dismissible is critical" */}
      <button
        type="button"
        onClick={handleDismiss}
        aria-label="Ocultar sugerencia"
        style={{
          flexShrink: 0,
          background: "none",
          border: "none",
          cursor: "pointer",
          color: "var(--tone-muted)",
          padding: "2px",
          lineHeight: 1,
          fontSize: "1rem",
        }}
      >
        ×
      </button>
    </div>
  );
}
