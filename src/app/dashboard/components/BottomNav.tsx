"use client";

import { useEffect, useState } from "react";
import { House, CurrencyCircleDollar, Package, Users, Truck, GearSix, Notepad, PlugsConnected } from "@phosphor-icons/react";
import type { TabKey } from "../lib/types";
import { primaryTabs } from "../lib/constants";

/** Returns true when the software keyboard is open (visualViewport shrinks). */
function useKeyboardOpen(): boolean {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      setOpen(Math.max(0, window.innerHeight - vv.offsetTop - vv.height) > 50);
    };
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, []);
  return open;
}

const NAV_LABEL: Partial<Record<TabKey, { en: string; es: string }>> = {
  main: { en: "Dashboard", es: "Principal" },
  sales: { en: "Sales", es: "Ventas" },
  inventory: { en: "Inventory", es: "Inventario" },
  clients: { en: "Clients", es: "Clientes" },
  servicios: { en: "Connect", es: "Conexión" },
};

function TabIcon({ tab, active, size = 22 }: { tab: TabKey; active: boolean; size?: number }) {
  const weight = active ? "fill" : "bold" as const;
  if (tab === "main") return <House size={size} weight={weight} />;
  if (tab === "sales") return <CurrencyCircleDollar size={size} weight={weight} />;
  if (tab === "budget") return <Notepad size={size} weight={weight} />;
  if (tab === "inventory") return <Package size={size} weight={weight} />;
  if (tab === "clients") return <Users size={size} weight={weight} />;
  if (tab === "suppliers") return <Truck size={size} weight={weight} />;
  if (tab === "servicios") return <PlugsConnected size={size} weight={weight} />;
  return <GearSix size={size} weight={weight} />;
}

interface BottomNavProps {
  activeTab: TabKey;
  setActiveTab: (tab: TabKey) => void;
  tabLabel: (tab: TabKey) => string;
  t: (en: string, es: string) => string;
}

export function BottomNav({ activeTab, setActiveTab, tabLabel, t }: BottomNavProps) {
  const keyboardOpen = useKeyboardOpen();
  const visibleTabs = primaryTabs;
  function navLabel(tab: TabKey) {
    const override = NAV_LABEL[tab];
    return override ? t(override.en, override.es) : tabLabel(tab);
  }

  function pick(tab: TabKey) {
    setActiveTab(tab);
  }

  // Hide the nav when the keyboard is open so the chat area fills the freed
  // space without leaving a blank gap (Bug 4 fix).
  if (keyboardOpen) return null;

  return (
    <>
      <nav
        className="md:hidden"
        aria-label={t("Main navigation", "Navegación principal")}
        style={{
          paddingBottom: "max(8px, env(safe-area-inset-bottom, 0px))",
          paddingTop: "8px",
          display: "flex",
          alignItems: "center",
          backgroundColor: "var(--surface)",
          borderTop: "none",
          minHeight: "var(--nav-bottom-height)",
          flexShrink: 0,
          touchAction: "none",
          overscrollBehavior: "none" as const,
        }}
      >
        {visibleTabs.map((tab) => {
          const active = activeTab === tab;
          return (
            <button
              key={tab}
              type="button"
              onClick={() => pick(tab)}
              aria-label={navLabel(tab)}
              aria-current={active ? "page" : undefined}
              className="active:scale-95 transition-transform duration-100"
              style={{
                flex: 1,
                minWidth: 0,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: "4px",
                background: "none",
                border: "none",
                cursor: "pointer",
                padding: "0 4px",
                color: active ? "var(--brand)" : "var(--tone-muted)",
                minHeight: "56px",
              }}
            >
              {/* Icon with pill indicator */}
              <div
                className="rounded-pill"
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: "64px",
                  height: "32px",
                  backgroundColor: active ? "var(--brand-soft)" : "transparent",
                  transition: "background-color 200ms ease",
                }}
              >
                <TabIcon tab={tab} active={active} size={24} />
              </div>
              <span
                className="text-caption"
                style={{
                  fontFamily: "var(--font-dm-sans)",
                  fontWeight: active ? 700 : 500,
                  lineHeight: 1,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  maxWidth: "100%",
                }}
              >
                {navLabel(tab)}
              </span>
            </button>
          );
        })}
      </nav>
    </>
  );
}
