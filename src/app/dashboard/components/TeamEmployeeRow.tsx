"use client";

import { useEffect, useMemo, useState } from "react";
import { Eye, Trash } from "@phosphor-icons/react";
import { freshPinKey } from "../lib/storage-keys";

interface EmployeeRecord {
  id: string;
  name: string;
  role: string;
  active: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  lockedUntil: string | null;
  failedPinAttempts: number;
}

interface ActivityRow {
  salesCount: number;
  salesTotal: number;
  stockMovements: number;
  cashMovements: number;
  lastActivityAt: string | null;
}

interface TeamEmployeeRowProps {
  employee: EmployeeRecord;
  activity: ActivityRow | null;
  currency: string;
  moneyFmt: (amount: number, currency: string) => string;
  onRevoke: (employeeId: string, name: string) => void;
  onUnlock: (employeeId: string) => void;
  t: (en: string, es: string) => string;
}

function formatTimeAgo(iso: string | null, t: (en: string, es: string) => string): string {
  if (!iso) return "—";
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return "—";
  const diff = Math.max(0, Date.now() - ts);
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return t("Just now", "Justo ahora");
  if (mins < 60) return t(`${mins}m ago`, `Hace ${mins} min`);
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t(`${hours}h ago`, `Hace ${hours}h`);
  const days = Math.floor(hours / 24);
  return t(`${days}d ago`, `Hace ${days}d`);
}

export function TeamEmployeeRow({
  employee,
  activity,
  currency,
  moneyFmt,
  onRevoke,
  onUnlock,
  t,
}: TeamEmployeeRowProps) {
  const lastTs = activity?.lastActivityAt ?? employee.lastLoginAt;
  const lastLabel = useMemo(() => formatTimeAgo(lastTs, t), [lastTs, t]);
  const roleLabel = t("Employee", "Empleado");
  const inactive = !employee.active;
  const isLocked = !!employee.lockedUntil && new Date(employee.lockedUntil) > new Date();
  const [revokeConfirming, setRevokeConfirming] = useState(false);

  // Fresh PIN recovery: one-time reveal from sessionStorage.
  // Written by useTeamData immediately after employee creation.
  // Cleared on first reveal so it shows exactly once per session.
  const [freshPin, setFreshPin] = useState<string | null>(null);
  const [pinRevealed, setPinRevealed] = useState(false);

  useEffect(() => {
    try {
      const stored = sessionStorage.getItem(freshPinKey(employee.id));
      if (stored) setFreshPin(stored);
    } catch { /* private browsing, ignore */ }
  }, [employee.id]);

  const handleRevealPin = () => {
    setPinRevealed(true);
    try { sessionStorage.removeItem(freshPinKey(employee.id)); } catch { /* ignore */ }
  };

  return (
    <div
      style={{
        background: "var(--surface, white)",
        border: "1px solid var(--border, #e5e5e5)",
        borderRadius: "12px",
        padding: "1rem",
        opacity: inactive ? 0.55 : 1,
      }}
    >
      <div className="flex items-center justify-between" style={{ gap: "0.75rem" }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
            <span
              className="font-fraunces"
              style={{
                fontSize: "1.125rem",
                fontWeight: 500,
                color: "var(--tone-strong)",
              }}
            >
              {employee.name}
            </span>
            <span
              style={{
                padding: "2px 8px",
                borderRadius: "999px",
                background: "var(--surface-subtle, #f4f1ec)",
                color: "var(--tone-muted)",
                fontSize: "0.875rem",
                fontWeight: 600,
                letterSpacing: "0.02em",
              }}
            >
              {roleLabel}
            </span>
            {inactive && (
              <span
                style={{
                  padding: "2px 8px",
                  borderRadius: "999px",
                  background: "rgba(220, 38, 38, 0.08)",
                  color: "var(--danger, #dc2626)",
                  fontSize: "0.875rem",
                  fontWeight: 600,
                }}
              >
                {t("Revoked", "Revocado")}
              </span>
            )}
            {isLocked && (
              <span
                style={{
                  padding: "2px 8px",
                  borderRadius: "999px",
                  background: "rgba(234, 88, 12, 0.10)",
                  color: "var(--warning, #ea580c)",
                  fontSize: "0.875rem",
                  fontWeight: 600,
                }}
              >
                {"🔒"} {t("Locked", "Bloqueado")}
              </span>
            )}
          </div>
          <div style={{ marginTop: "2px", fontSize: "0.875rem", color: "var(--tone-muted)" }}>
            {t("Last activity: ", "Última actividad: ")}{lastLabel}
          </div>
        </div>
        {!inactive && (
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            {/* Fresh PIN reveal: available once per session if the owner missed it in the banner */}
            {freshPin && !pinRevealed && (
              <button
                type="button"
                onClick={handleRevealPin}
                aria-label={t(`Reveal PIN for ${employee.name}`, `Ver PIN de ${employee.name}`)}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "5px",
                  padding: "4px 12px",
                  minHeight: "44px",
                  border: "1px solid var(--warning, #ea580c)",
                  background: "rgba(234, 88, 12, 0.06)",
                  color: "var(--warning, #ea580c)",
                  cursor: "pointer",
                  borderRadius: "8px",
                  fontSize: "0.875rem",
                  fontWeight: 600,
                  whiteSpace: "nowrap",
                }}
              >
                <Eye size={15} weight="bold" />
                {t("Show PIN once more", "Ver código una vez más")}
              </button>
            )}
            {freshPin && pinRevealed && (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "flex-end",
                  gap: "2px",
                }}
              >
                <span
                  className="font-fraunces"
                  style={{
                    fontSize: "1.25rem",
                    fontWeight: 500,
                    letterSpacing: "0.06em",
                    color: "var(--tone-strong)",
                  }}
                >
                  {freshPin}
                </span>
                <span style={{ fontSize: "0.875rem", color: "var(--tone-muted)", fontStyle: "italic" }}>
                  {t("Note it — won't show again", "Anotalo — no se vuelve a mostrar")}
                </span>
              </div>
            )}
            {isLocked && (
              <button
                type="button"
                onClick={() => onUnlock(employee.id)}
                aria-label={t(`Unlock ${employee.name}`, `Desbloquear a ${employee.name}`)}
                style={{
                  border: "1px solid var(--border, #e5e5e5)",
                  background: "var(--surface, white)",
                  color: "var(--tone-strong)",
                  cursor: "pointer",
                  padding: "4px 12px",
                  borderRadius: "8px",
                  fontSize: "0.875rem",
                  fontWeight: 600,
                }}
              >
                {t("Unlock", "Desbloquear")}
              </button>
            )}
            {revokeConfirming ? (
              <div style={{ display: "flex", alignItems: "center", gap: "0.375rem" }}>
                <button
                  type="button"
                  onClick={() => { onRevoke(employee.id, employee.name); setRevokeConfirming(false); }}
                  aria-label={t(`Confirm revoke ${employee.name}`, `Confirmar revocar a ${employee.name}`)}
                  style={{
                    minWidth: "44px",
                    minHeight: "44px",
                    padding: "0 12px",
                    border: "1px solid var(--danger, #dc2626)",
                    background: "var(--danger, #dc2626)",
                    color: "white",
                    cursor: "pointer",
                    borderRadius: "8px",
                    fontSize: "0.875rem",
                    fontWeight: 700,
                  }}
                >
                  {t("Yes", "Sí")}
                </button>
                <button
                  type="button"
                  onClick={() => setRevokeConfirming(false)}
                  aria-label={t("Cancel revocation", "Cancelar revocación")}
                  style={{
                    minWidth: "44px",
                    minHeight: "44px",
                    padding: "0 12px",
                    border: "1px solid var(--border, #e5e5e5)",
                    background: "var(--surface, white)",
                    color: "var(--tone-strong)",
                    cursor: "pointer",
                    borderRadius: "8px",
                    fontSize: "0.875rem",
                    fontWeight: 600,
                  }}
                >
                  {t("No", "No")}
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setRevokeConfirming(true)}
                aria-label={t(`Revoke ${employee.name}`, `Revocar a ${employee.name}`)}
                title={t("Revoke access", "Revocar acceso")}
                style={{
                  minWidth: "44px",
                  minHeight: "44px",
                  border: "none",
                  background: "transparent",
                  color: "var(--tone-muted)",
                  cursor: "pointer",
                  padding: "8px",
                  borderRadius: "8px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Trash size={18} />
              </button>
            )}
          </div>
        )}
      </div>

      <div
        style={{
          marginTop: "0.875rem",
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap: "0.5rem",
        }}
      >
        <Metric
          label={t("Sales", "Ventas")}
          value={String(activity?.salesCount ?? 0)}
          sublabel={activity?.salesTotal ? moneyFmt(activity.salesTotal, currency) : "—"}
        />
        <Metric
          label={t("Stock", "Stock")}
          value={String(activity?.stockMovements ?? 0)}
          sublabel={t("loads", "cargas")}
        />
        <Metric
          label={t("Cash", "Caja")}
          value={String(activity?.cashMovements ?? 0)}
          sublabel={t("movements", "movim.")}
        />
      </div>
    </div>
  );
}

function Metric({ label, value, sublabel }: { label: string; value: string; sublabel: string }) {
  return (
    <div
      style={{
        background: "var(--surface-subtle, #f8f6f1)",
        borderRadius: "8px",
        padding: "0.625rem 0.75rem",
      }}
    >
      <div
        style={{
          fontSize: "0.875rem",
          fontWeight: 600,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          color: "var(--tone-muted)",
        }}
      >
        {label}
      </div>
      <div
        className="t-heading-2"
        style={{
          color: "var(--tone-strong)",
          lineHeight: 1.1,
          marginTop: "2px",
        }}
      >
        {value}
      </div>
      <div style={{ fontSize: "0.875rem", color: "var(--tone-muted)", marginTop: "1px" }}>
        {sublabel}
      </div>
    </div>
  );
}
