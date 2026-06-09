"use client";

import { CARD_CLASS, CARD_STYLE } from "./SettingsShared";
import { ServiceDiagram, SupervisorDiagram } from "./ServiciosTab.diagram";

export interface ProviderStatus {
  id: string;
  label: string;
  connected: boolean;
  expiresAt?: string;
  value?: string;
  connectAction?: { type: string; panel: string };
}

/** Discriminated card type — controls diagram variant and header copy. */
export type AgentKind =
  | "supervisor"
  | "companion"
  | "fiscal"
  | "ventas"
  // Logística couriers: Andreani, OCA, Correo + PedidosYa (same-city delivery).
  | "logistica"
  // "whatsapp" kind retained for the WhatsApp Business connect form; the standalone
  // card was folded into Comunicaciones 2026-06-04 (WhatsApp is a comms channel).
  | "whatsapp"
  // BYOA communication channels: WhatsApp Business, Twilio SMS, Resend email.
  | "comunicaciones";

export interface AgentCardProps {
  kind: AgentKind;
  title: string;
  subtitle: string;
  statusLabel?: string;
  providers?: ProviderStatus[];
  /** Contextual message rendered below the diagram. */
  contextMessage?: string;
  /** Called when a service node is clicked. Parent opens the connect modal. */
  onProviderClick?: (provider: ProviderStatus) => void;
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const TITLE_STYLE: React.CSSProperties = {
  fontFamily: "var(--font-dm-sans)",
  fontSize: "1rem",
  fontWeight: 700,
  color: "var(--tone-strong)",
  margin: "0 0 2px",
};

const SUBTITLE_STYLE: React.CSSProperties = {
  fontFamily: "var(--font-dm-sans)",
  fontSize: "0.875rem",
  color: "var(--tone-muted)",
  margin: 0,
  lineHeight: 1.45,
};

const DIVIDER_STYLE: React.CSSProperties = {
  border: "none",
  borderTop: "1px solid var(--border)",
  margin: "16px 0",
};

const STATUS_BADGE_STYLE: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "5px",
  fontFamily: "var(--font-dm-sans)",
  fontSize: "0.8125rem",
  fontWeight: 600,
  color: "var(--success)",
  background: "var(--success-soft)",
  borderRadius: "var(--radius-pill)",
  padding: "3px 10px",
  flexShrink: 0,
};

const CONTEXT_MSG_STYLE: React.CSSProperties = {
  fontFamily: "var(--font-dm-sans)",
  fontSize: "0.875rem",
  color: "var(--tone-body)",
  margin: 0,
  lineHeight: 1.5,
  padding: "12px 14px",
  background: "var(--brand-soft)",
  borderRadius: "var(--radius-md)",
  borderLeft: "3px solid var(--brand)",
};

// ─── Agent tag chip (eyebrow label) ──────────────────────────────────────────

const AGENT_KIND_LABELS: Record<AgentKind, string> = {
  supervisor: "Supervisor",
  companion: "Companion",
  fiscal: "Fiscal",
  ventas: "Ventas",
  logistica: "Logística",
  whatsapp: "WhatsApp",
  comunicaciones: "Comunicaciones",
};

function AgentChip({ kind }: { kind: AgentKind }) {
  return (
    <span
      aria-label={`Agente: ${AGENT_KIND_LABELS[kind]}`}
      style={{
        display: "inline-block",
        fontFamily: "var(--font-dm-sans)",
        fontSize: "0.75rem",
        fontWeight: 700,
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        color: "var(--brand)",
        background: "var(--brand-soft)",
        borderRadius: "var(--radius-pill)",
        padding: "2px 8px",
        marginBottom: "6px",
      }}
    >
      {AGENT_KIND_LABELS[kind]}
    </span>
  );
}

// ─── AgentCard ────────────────────────────────────────────────────────────────

export function AgentCard({
  kind,
  title,
  subtitle,
  statusLabel,
  providers,
  contextMessage,
  onProviderClick,
}: AgentCardProps) {
  const hasProviders = providers && providers.length > 0;
  const showDiagram = kind === "supervisor" || hasProviders;

  return (
    <div className={CARD_CLASS} style={CARD_STYLE}>
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: "12px",
          marginBottom: "2px",
        }}
      >
        <div style={{ minWidth: 0, flex: 1 }}>
          <AgentChip kind={kind} />
          <p style={TITLE_STYLE}>{title}</p>
          <p style={SUBTITLE_STYLE}>{subtitle}</p>
        </div>

        {statusLabel && (
          <span style={STATUS_BADGE_STYLE}>
            <svg
              aria-hidden="true"
              width="10"
              height="10"
              viewBox="0 0 10 10"
              fill="none"
            >
              <circle cx="5" cy="5" r="4" fill="var(--success)" />
            </svg>
            {statusLabel}
          </span>
        )}
      </div>

      {/* Diagram */}
      {showDiagram && (
        <>
          <hr style={DIVIDER_STYLE} />

          {kind === "supervisor" ? (
            <SupervisorDiagram />
          ) : (
            <ServiceDiagram
              agentLabel={AGENT_KIND_LABELS[kind]}
              providers={providers ?? []}
              dashedLines={false}
              onProviderClick={onProviderClick}
            />
          )}
        </>
      )}

      {/* Contextual message */}
      {contextMessage && (
        <>
          <hr style={{ ...DIVIDER_STYLE, marginTop: "16px" }} />
          <p style={CONTEXT_MSG_STYLE}>{contextMessage}</p>
        </>
      )}
    </div>
  );
}
