"use client";

import type { ProviderStatus } from "./ServiciosTab.cards";
import { getServiceTip } from "./ServiciosTab.copy";

// ─── Dot indicator ────────────────────────────────────────────────────────────
// Green = connected, RED = disconnected, neutral = no-status (e.g. always-on agents).

export function Dot({ connected, neutral }: { connected: boolean; neutral?: boolean }) {
  const color = neutral
    ? "var(--border)"
    : connected
      ? "var(--success)"
      : "var(--border-strong)";
  return (
    <span
      role="img"
      aria-label={neutral ? "Indicador" : connected ? "Conectado" : "Sin conectar"}
      style={{
        display: "inline-block",
        width: "8px",
        height: "8px",
        borderRadius: "50%",
        backgroundColor: color,
        boxShadow: connected && !neutral ? `0 0 0 2px var(--success-soft)` : undefined,
        flexShrink: 0,
      }}
    />
  );
}

// ─── Agent node (filled primary or subtle secondary) ─────────────────────────

interface AgentNodeProps {
  label: string;
  primary?: boolean;
}

export function AgentNode({ label, primary = false }: AgentNodeProps) {
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "10px 18px",
        borderRadius: "var(--radius-md)",
        backgroundColor: primary ? "var(--brand)" : "var(--surface-subtle)",
        border: primary
          ? "1.5px solid var(--brand)"
          : "1.5px solid var(--border)",
        fontFamily: "var(--font-dm-sans)",
        fontSize: "0.8125rem",
        fontWeight: 600,
        color: primary ? "var(--accent-cream)" : "var(--tone-muted)",
        letterSpacing: "0.01em",
        whiteSpace: "nowrap",
        userSelect: "none",
      }}
    >
      {label}
    </div>
  );
}

// ─── Service node ─────────────────────────────────────────────────────────────
// The whole node IS the button. Click anywhere on the box opens the connect
// modal (or refresh-status pattern for connected). Red dot = disconnected,
// green dot with halo = connected.

function getExpiryColor(expiresAt: string): string {
  const now = Date.now();
  const exp = new Date(expiresAt).getTime();
  const diffDays = (exp - now) / (1000 * 60 * 60 * 24);
  if (diffDays < 0) return "#ef4444"; // past — red
  if (diffDays < 7) return "#f59e0b"; // < 7 days — amber
  return "var(--tone-muted)";         // neutral
}

interface ServiceNodeProps {
  provider: ProviderStatus;
  /** Called when user clicks the node — parent opens the connect modal. */
  onClick?: (provider: ProviderStatus) => void;
}

export function ServiceNode({ provider, onClick }: ServiceNodeProps) {
  const tip = getServiceTip(provider.id, provider);
  const clickable = !!onClick;

  function handleClick() {
    if (onClick) onClick(provider);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
      {/* The button IS the node */}
      <button
        type="button"
        onClick={clickable ? handleClick : undefined}
        disabled={!clickable}
        aria-label={
          provider.connected
            ? `${provider.label} conectado. Click para gestionar.`
            : `${provider.label} sin conectar. Click para conectar.`
        }
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "10px",
          // WCAG 2.2 AA: ≥44px touch target (Apple HIG / Material 48dp guidance).
          minHeight: "44px",
          padding: "10px 16px",
          borderRadius: "var(--radius-md)",
          backgroundColor: provider.connected
            ? "var(--success-soft)"
            : "var(--surface-subtle)",
          border: provider.connected
            ? "1.5px solid var(--success)"
            : "1.5px solid var(--border)",
          fontFamily: "var(--font-dm-sans)",
          fontSize: "0.9375rem",
          fontWeight: 600,
          color: "var(--tone-strong)",
          whiteSpace: "nowrap",
          userSelect: "none",
          cursor: clickable ? "pointer" : "default",
          transition: "transform 120ms ease, box-shadow 120ms ease",
        }}
        onPointerDown={(e) => {
          if (clickable) e.currentTarget.style.transform = "scale(0.97)";
        }}
        onPointerUp={(e) => {
          if (clickable) e.currentTarget.style.transform = "";
        }}
        onPointerLeave={(e) => {
          if (clickable) e.currentTarget.style.transform = "";
        }}
        onPointerCancel={(e) => {
          if (clickable) e.currentTarget.style.transform = "";
        }}
        onMouseDown={(e) => {
          if (clickable) e.currentTarget.style.transform = "scale(0.97)";
        }}
        onMouseUp={(e) => {
          if (clickable) e.currentTarget.style.transform = "";
        }}
        onMouseLeave={(e) => {
          if (clickable) e.currentTarget.style.transform = "";
        }}
      >
        <Dot connected={provider.connected} />
        <span>{provider.label}</span>
        {provider.connected && provider.expiresAt && (() => {
          const expiryColor = getExpiryColor(provider.expiresAt);
          const isUrgent = expiryColor !== "var(--tone-muted)";
          return (
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "4px",
                fontSize: "0.875rem",
                fontWeight: isUrgent ? 600 : 400,
                color: expiryColor,
                backgroundColor: isUrgent ? `${expiryColor}18` : undefined,
                padding: isUrgent ? "2px 6px" : undefined,
                borderRadius: isUrgent ? "4px" : undefined,
              }}
            >
              {isUrgent && (
                <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                  <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                  <line x1="12" y1="9" x2="12" y2="13" />
                  <line x1="12" y1="17" x2="12.01" y2="17" />
                </svg>
              )}
              Vence{" "}
              {new Date(provider.expiresAt).toLocaleDateString("es-AR", {
                day: "2-digit",
                month: "2-digit",
              })}
            </span>
          );
        })()}
        {provider.connected && provider.value && (
          <span
            style={{
              fontSize: "0.875rem",
              fontWeight: 400,
              color: "var(--tone-muted)",
              maxWidth: "120px",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {provider.value}
          </span>
        )}
        {clickable && !provider.connected && (
          <span
            aria-hidden
            style={{
              marginLeft: "auto",
              fontSize: "0.875rem",
              fontWeight: 600,
              color: "var(--brand)",
              letterSpacing: "0.02em",
            }}
          >
            Conectar
          </span>
        )}
      </button>

      {/* Contextual tip */}
      {tip && (
        <p
          style={{
            fontFamily: "var(--font-dm-sans)",
            fontSize: "0.875rem",
            color: "var(--tone-muted)",
            margin: 0,
            lineHeight: 1.45,
          }}
        >
          {tip}
        </p>
      )}
    </div>
  );
}

// ─── SVG connector overlay ────────────────────────────────────────────────────

export interface ConnectorPath {
  key: string;
  d: string;
  connected: boolean;
  dashed: boolean;
}

export function ConnectorSVG({ paths }: { paths: ConnectorPath[] }) {
  return (
    <svg
      aria-hidden="true"
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        pointerEvents: "none",
        overflow: "visible",
      }}
    >
      {paths.map((p) => (
        <path
          key={p.key}
          d={p.d}
          fill="none"
          stroke={p.connected ? "var(--success)" : "var(--border)"}
          strokeWidth={p.dashed ? 1.5 : 2}
          strokeDasharray={p.dashed ? "5 4" : undefined}
          opacity={p.connected ? 0.7 : 0.4}
        />
      ))}
    </svg>
  );
}

// ─── Shared layout style string ───────────────────────────────────────────────

export const DIAGRAM_MOBILE_CSS = `
  @media (max-width: 479px) {
    .service-diagram-layout {
      flex-direction: column;
      align-items: flex-start;
      gap: 0;
    }
    .service-diagram-layout > *:first-child {
      margin-bottom: 0;
    }
    .service-diagram-layout > *:last-child {
      border-left: 2px solid var(--border);
      padding-left: 20px;
      margin-left: 16px;
      padding-top: 12px;
      padding-bottom: 4px;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .service-diagram-layout * { transition: none !important; }
  }
`;
