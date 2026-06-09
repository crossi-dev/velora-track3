"use client";

import { useEffect, useRef, useState } from "react";
import { Bell, X } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { useFocusTrap } from "../lib/hooks/useFocusTrap";
import { DashboardNotification } from "../lib/types";
import { SwipeableNotificationRow } from "./SwipeableNotificationRow";

// eslint-disable-next-line max-lines-per-function -- composition root, not a logic violation
export function NotificationsBell({
  notifications,
  t,
  onMarkSeen,
  unresolvedCount,
  onDismiss,
  onDismissAll,
}: {
  notifications: DashboardNotification[];
  t: (en: string, es: string) => string;
  onMarkSeen: (items: DashboardNotification[]) => void;
  unresolvedCount: number;
  onDismiss: (id: string) => void;
  onDismissAll: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(panelRef, open);
  useEffect(() => {
    if (!open) return;

    const closePanel = () => setOpen(false);

    const handlePointerDown = (event: MouseEvent | TouchEvent) => {
      if (!ref.current) return;
      if (ref.current.contains(event.target as Node)) return;
      closePanel();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closePanel();
    };

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("touchstart", handlePointerDown, { passive: true });
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("touchstart", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    onMarkSeen(notifications);
  }, [notifications, open, onMarkSeen]);

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <Button
        type="button"
        onClick={() => {
          onMarkSeen(notifications);
          setOpen((v) => !v);
        }}
        aria-label={t("Notifications", "Notificaciones")}
        aria-haspopup="dialog"
        aria-expanded={open}
        variant="ghost"
        size="icon"
        style={{ position: "relative" }}
        className="hover:bg-[var(--surface-subtle)] hover:text-[var(--tone-strong)]"
        onMouseEnter={() => onMarkSeen(notifications)}
        onFocus={() => onMarkSeen(notifications)}
      >
        <Bell size={18} aria-hidden strokeWidth={1.8} />
        {unresolvedCount > 0 && (
          <span
            aria-label={`${unresolvedCount} ${t("notifications", "notificaciones")}`}
            style={{
              position: "absolute",
              top: "6px",
              right: "6px",
              width: "8px",
              height: "8px",
              borderRadius: "50%",
              backgroundColor: "var(--danger, #ef4444)",
              border: "1.5px solid var(--background)",
              pointerEvents: "none",
            }}
          />
        )}
      </Button>

      {open && (
        <div
          ref={panelRef}
          role="dialog"
          id="velora-notifications-panel"
          aria-modal="true"
          aria-label={t("Notifications", "Notificaciones")}
          className="notification-panel-enter-active"
          style={{
            position: "absolute",
            top: "calc(100% + 8px)",
            right: 0,
            width: "min(320px, 90vw)",
            backgroundColor: "var(--surface)",
            border: "none",
            borderRadius: "1.75rem",
            boxShadow: "0 4px 16px rgba(0,0,0,0.12)",
            zIndex: "var(--z-toast)" as unknown as number,
            overflow: "hidden",
            animation: "notificationPanelIn 150ms ease both",
          }}
        >
          <div
            style={{
              padding: "12px 16px",
              borderBottom: "none",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "8px",
            }}
          >
            <span className="text-caption" style={{ fontFamily: "var(--font-dm-sans)", fontWeight: 700, color: "var(--tone-muted)" }}>
              {t("Notifications", "Notificaciones")}
            </span>
            {notifications.length > 0 && (
              <button
                type="button"
                onClick={onDismissAll}
                className="text-caption"
                style={{ fontFamily: "var(--font-dm-sans)", color: "var(--tone-muted)", background: "none", border: "none", cursor: "pointer", padding: "0 0.5rem", flexShrink: 0, minHeight: "44px", display: "inline-flex", alignItems: "center" }}
              >
                {t("Clear all", "Limpiar todo")}
              </button>
            )}
          </div>

          {notifications.length === 0 ? (
            <p
              className="text-caption"
              style={{
                fontFamily: "var(--font-dm-sans)",
                color: "var(--tone-muted)",
                padding: "16px",
              }}
            >
              {t("No pending notifications.", "No hay notificaciones pendientes.")}
            </p>
          ) : (
            <div style={{ maxHeight: "320px", overflowY: "auto" }}>
              {notifications.map((item) => {
                const rowStyle: React.CSSProperties = {
                  padding: "12px 16px",
                  borderBottom: "none",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: "8px",
                };
                const dismissBtn = (
                  <button
                    type="button"
                    aria-label={t("Close", "Cerrar")}
                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); onDismiss(item.id); }}
                    className="opacity-0 md:opacity-100"
                    style={{ flexShrink: 0, background: "none", border: "none", cursor: "pointer", color: "var(--tone-faint)", padding: "6px", minWidth: "44px", minHeight: "44px", borderRadius: "6px", display: "inline-flex", alignItems: "center", justifyContent: "center" }}
                  >
                    <X size={14} strokeWidth={2.5} aria-hidden />
                  </button>
                );
                const rowContent = (
                  <>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <p
                        className="text-caption"
                        style={{
                          fontFamily: "var(--font-dm-sans)",
                          fontWeight: 600,
                          color:
                            item.kind === "critical"
                              ? "var(--danger, #ef4444)"
                              : item.kind === "success"
                                ? "var(--success, #16a34a)"
                                : "var(--tone-strong)",
                          marginBottom: "2px",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {item.title}
                      </p>
                      {item.body ? (
                        <p
                          className="text-caption line-clamp-3"
                          style={{
                            fontFamily: "var(--font-dm-sans)",
                            color: "var(--tone-muted)",
                          }}
                        >
                          {item.body}
                        </p>
                      ) : null}
                    </div>
                    {item.ctaLabel ? (
                      <span
                        className="text-caption"
                        style={{
                          flexShrink: 0,
                          fontFamily: "var(--font-dm-sans)",
                          fontWeight: 600,
                          color: "var(--tone-strong)",
                          backgroundColor: "var(--surface-subtle)",
                          border: "none",
                          borderRadius: "var(--radius-sm)",
                          padding: "6px 10px",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {item.ctaLabel}
                      </span>
                    ) : null}
                    {dismissBtn}
                  </>
                );

                if (item.href) {
                  return (
                    <SwipeableNotificationRow key={item.id} itemId={item.id} onDismiss={onDismiss}>
                      <a
                        href={item.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={() => { onMarkSeen([item]); setOpen(false); }}
                        style={{ ...rowStyle, textDecoration: "none", color: "inherit", cursor: "pointer" }}
                      >
                        {rowContent}
                      </a>
                    </SwipeableNotificationRow>
                  );
                }
                return (
                  <SwipeableNotificationRow key={item.id} itemId={item.id} onDismiss={onDismiss}>
                    <div style={rowStyle}>
                      {rowContent}
                    </div>
                  </SwipeableNotificationRow>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
