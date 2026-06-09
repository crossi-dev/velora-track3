"use client";

import { useRouter } from "next/navigation";
import { Globe, SignOut } from "@phosphor-icons/react";
import {
  Sidebar as ShadcnSidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import type { TabKey } from "../lib/types";
import { primaryTabs, secondaryTabs, employeePrimaryTabs, employeeSecondaryTabs } from "../lib/constants";
import { OfflineQueueBadge } from "./OfflineQueueBadge";
import { useRole } from "../lib/contexts";
import { useDashboardLang } from "../lib/DashboardLangContext";
import { SidebarSectionIcon } from "./SidebarParts";
import { handleSignOut } from "@/lib/handle-sign-out";

export { SidebarSectionIcon } from "./SidebarParts";

interface VeloraSidebarProps {
  activeTab: TabKey;
  setActiveTab: (tab: TabKey) => void;
  tabLabel: (tab: TabKey) => string;
  t: (en: string, es: string) => string;
}

// eslint-disable-next-line max-lines-per-function -- composition root
export function VeloraSidebar({ activeTab, setActiveTab, tabLabel, t }: VeloraSidebarProps) {
  const role = useRole();
  const { lang, setLang } = useDashboardLang();
  const router = useRouter();

  const visiblePrimary = role === "employee" ? employeePrimaryTabs : primaryTabs;
  const visibleSecondary = role === "employee" ? employeeSecondaryTabs : secondaryTabs;
  const NAVIGABLE_TABS: readonly TabKey[] = [...visiblePrimary, ...visibleSecondary];

  async function handleLogout() {
    if (role === "employee") {
      try { await fetch("/api/employees/logout", { method: "POST" }); } catch { /* best-effort */ }
      try {
        for (let i = localStorage.length - 1; i >= 0; i--) {
          const key = localStorage.key(i);
          if (key && key.startsWith("velora-dashboard-draft:")) {
            localStorage.removeItem(key);
          }
        }
      } catch { /* localStorage disabled */ }
      router.push("/employee-login");
      return;
    }
    await handleSignOut();
  }

  return (
    <ShadcnSidebar
      collapsible="icon"
      data-print-hide
      className="border-sidebar-border"
      style={{
        backgroundColor: "var(--sidebar-bg)",
        borderColor: "var(--sidebar-border)",
        color: "var(--sidebar-text)",
      }}
    >
      {/* Header: hamburger + offline badge.
          Velora UX choice (Carlos 2026-05-27): the canonical shadcn pattern places
          SidebarTrigger in SidebarInset's header; we deliberately move it inside
          the sidebar so the hamburger lives with the navigation, matching the
          web-app convention Carlos expects. */}
      {/* MD3 top-app-bar leading-icon pattern (m3.material.io/components/top-app-bar/specs):
          48dp touch-target button with icon centered inside → icon optical-left = (48-16)/2 = 16px,
          matching the brand's 16px content inset in .dashboard-header. Zero leading padding on the
          header; the button self-aligns. In collapsed (48px rail) mode the 48px button fills the
          rail exactly — no overflow, no conditional math. */}
      <SidebarHeader
        className="p-0"
        style={{ borderBottom: "1px solid var(--sidebar-border)", minHeight: "var(--nav-top-height)", flexShrink: 0, justifyContent: "center" }}
      >
        <div className="flex items-center gap-2 overflow-hidden">
          <SidebarTrigger
            aria-label="Toggle sidebar"
            className="h-12 w-12 flex-shrink-0"
          />
          <span className="group-data-[collapsible=icon]:hidden">
            <OfflineQueueBadge t={t} />
          </span>
        </div>
      </SidebarHeader>

      {/* Nav items */}
      <SidebarContent>
        <SidebarMenu>
          {NAVIGABLE_TABS.map((tab) => (
            <SidebarMenuItem key={tab}>
              <SidebarMenuButton
                onClick={() => setActiveTab(tab)}
                isActive={activeTab === tab}
                tooltip={tabLabel(tab)}
                aria-current={activeTab === tab ? "page" : undefined}
                style={{
                  color: activeTab === tab ? "var(--sidebar-active-text)" : "var(--sidebar-text-muted)",
                  backgroundColor: activeTab === tab ? "var(--sidebar-active-bg)" : undefined,
                  fontWeight: activeTab === tab ? 600 : 500,
                  fontSize: "0.875rem",
                }}
              >
                <SidebarSectionIcon tab={tab} active={activeTab === tab} />
                <span>{tabLabel(tab)}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarContent>

      {/* Footer: lang toggle + sign out */}
      <SidebarFooter style={{ borderTop: "1px solid var(--sidebar-border)" }}>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              onClick={() => setLang(lang === "en" ? "es-AR" : "en")}
              tooltip={lang === "en" ? "Español" : "English"}
              style={{ color: "var(--sidebar-text-muted)", fontWeight: 500, fontSize: "0.875rem" }}
            >
              <Globe size={18} weight="regular" aria-hidden />
              <span>{lang === "en" ? "Español" : "English"}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              onClick={() => void handleLogout()}
              tooltip={t("Sign out", "Cerrar sesión")}
              style={{ color: "var(--sidebar-text-muted)", fontWeight: 500, fontSize: "0.875rem" }}
            >
              <SignOut size={18} weight="regular" aria-hidden />
              <span>{t("Sign out", "Cerrar sesión")}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>

      <SidebarRail />
    </ShadcnSidebar>
  );
}

// Compatibility alias — existing code that imports `Sidebar` keeps working.
export { VeloraSidebar as Sidebar };
