"use client";

import { House, TrendUp, Package, Users, UsersThree, Truck, GearSix, Notepad, CheckCircle, Receipt, PlugsConnected, ChatsCircle } from "@phosphor-icons/react";
import type { TabKey } from "../lib/types";

export interface RecentTrace {
  id: string;
  text: string;
  timestamp?: number;
}

export function formatTimeAgo(ts: number, t: (en: string, es: string) => string): string {
  const diff = Math.max(0, Date.now() - ts);
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return t("Just now", "Justo ahora");
  if (mins < 60) return t(`${mins} min ago`, `Hace ${mins} min`);
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t(`${hours}h ago`, `Hace ${hours}h`);
  const days = Math.floor(hours / 24);
  return t(`${days}d ago`, `Hace ${days}d`);
}

export function SidebarSectionIcon({ tab, active }: { tab: TabKey; active?: boolean }) {
  const weight = active ? "bold" : "regular" as const;
  const size = 18;
  if (tab === "main")       return <House size={size} weight={weight} />;
  if (tab === "sales")      return <TrendUp size={size} weight={weight} />;
  if (tab === "budget")     return <Notepad size={size} weight={weight} />;
  if (tab === "inventory")  return <Package size={size} weight={weight} />;
  if (tab === "clients")    return <Users size={size} weight={weight} />;
  if (tab === "suppliers")  return <Truck size={size} weight={weight} />;
  if (tab === "invoices")   return <Receipt size={size} weight={weight} />;
  if (tab === "team")          return <UsersThree size={size} weight={weight} />;
  if (tab === "servicios")     return <PlugsConnected size={size} weight={weight} />;
  if (tab === "conversations") return <ChatsCircle size={size} weight={weight} />;
  return <GearSix size={size} weight={weight} />;
}

interface SidebarRecentTracesProps {
  traces: RecentTrace[];
  t: (en: string, es: string) => string;
}

export function SidebarRecentTraces({ traces, t }: SidebarRecentTracesProps) {
  if (traces.length === 0) return null;
  return (
    <div
      className="overflow-y-auto"
      style={{ borderTop: "1px solid var(--sidebar-border)", flexShrink: 1, minHeight: 0, maxHeight: "40%" }}
    >
      <p
        style={{
          fontFamily: "var(--font-dm-sans)",
          fontSize: "0.875rem",
          fontWeight: 600,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: "var(--sidebar-text-muted)",
          padding: "14px 18px 8px",
          margin: 0,
        }}
      >
        {t("Recent", "Recientes")}
      </p>
      {traces.map((trace) => (
        <div key={trace.id} className="flex items-start gap-2.5" style={{ padding: "6px 18px" }}>
          <CheckCircle
            size={14}
            weight="fill"
            style={{ color: "var(--accent-green)", flexShrink: 0, marginTop: "2px" }}
            aria-hidden
          />
          <div style={{ minWidth: 0, flex: 1 }}>
            <p
              style={{
                fontFamily: "var(--font-dm-sans)",
                fontSize: "1rem",
                fontWeight: 500,
                color: "var(--sidebar-active-text)",
                lineHeight: 1.35,
                margin: 0,
                overflow: "hidden",
                textOverflow: "ellipsis",
                display: "-webkit-box",
                WebkitLineClamp: 2,
                WebkitBoxOrient: "vertical",
              }}
            >
              {trace.text}
            </p>
            {trace.timestamp && (
              <p
                style={{
                  fontFamily: "var(--font-dm-sans)",
                  fontSize: "0.875rem",
                  color: "var(--sidebar-text-muted)",
                  margin: "1px 0 0",
                  lineHeight: 1.2,
                }}
              >
                {formatTimeAgo(trace.timestamp, t)}
              </p>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
