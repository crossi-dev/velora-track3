"use client";

import { useState } from "react";
import { DotsThreeVertical as MoreVertical } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { DashboardNotification } from "../lib/types";
import { NotificationsBell } from "./NotificationsBell";
import { useNotificationsStore } from "../lib/hooks/useNotificationsStore";
import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar";

/** Reads the sidebar_state cookie (written by shadcn SidebarProvider on toggle).
 *  Lazy in useState init so it runs once per mount on the client.
 *  Default: collapsed (false). Owner explicitly opens it when needed; first-time
 *  visit shows the dashboard surface uncluttered. Once toggled, the cookie
 *  persists the choice. */
function readSidebarCookie(): boolean {
  if (typeof document === "undefined") return false;
  if (/sidebar_state=true/.test(document.cookie)) return true;
  if (/sidebar_state=false/.test(document.cookie)) return false;
  return false;
}

interface DashboardLayoutProps {
  t: (english: string, spanish: string) => string;
  children: React.ReactNode;
  sidebar?: React.ReactNode;
  onQuickActionsClick?: () => void;
  quickActionOpen?: boolean;
  contentScrollable?: boolean;
  title?: string;
  notifications?: DashboardNotification[];
  bottomNav?: React.ReactNode;
}

export function DashboardLayout({
  t,
  children,
  sidebar,
  onQuickActionsClick,
  quickActionOpen = false,
  contentScrollable = true,
  title,
  notifications = [],
  bottomNav,
}: DashboardLayoutProps) {
  const {
    visibleNotifications,
    unresolvedCount,
    markSeen: markNotificationsSeen,
    dismiss: dismissNotification,
    dismissAll: dismissAllNotifications,
  } = useNotificationsStore(notifications);

  // Read the sidebar_state cookie on mount so the layout opens in the
  // last state the user chose. Lazy init = synchronous on first render,
  // no flicker.
  const [defaultOpen] = useState(readSidebarCookie);

  return (
    /* SidebarProvider creates the top-level flex row that the sidebar and
       SidebarInset share. It also wires cookie persistence and Ctrl+B. */
    <SidebarProvider
      defaultOpen={defaultOpen}
      className="dashboard-sidebar-provider"
      style={{ height: "100dvh", overflow: "hidden" }}
    >
      {/* Sidebar is a direct child of SidebarProvider — flex sibling of SidebarInset.
          This gives us the grow/shrink layout without margin-left hacks. */}
      {sidebar}

      {/* SidebarInset takes the remaining horizontal space (flex-1) and
          stacks the header + main content + bottom nav vertically. */}
      <SidebarInset
        style={{
          minHeight: "100dvh",
          maxHeight: "100dvh",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          background: "var(--background)",
          // min-width: 0 prevents SidebarInset from overflowing its flex-1
          // slot in the SidebarProvider flex row. Without this, SidebarInset's
          // default min-width: auto lets it grow wider than the remaining
          // space, causing the fixed sidebar panel (z-10) to visually overlap
          // chat content. Canonical flex shrink fix per MDN + defensivecss.dev.
          minWidth: 0,
        }}
      >
        <header className="dashboard-header" data-print-hide>
          <div className="dashboard-header-left">
            <div className="dashboard-title">
              {title ?? "Velora"}
            </div>
          </div>

          <div className="dashboard-header-right">
            <NotificationsBell
              notifications={visibleNotifications}
              t={t}
              onMarkSeen={markNotificationsSeen}
              unresolvedCount={unresolvedCount}
              onDismiss={dismissNotification}
              onDismissAll={dismissAllNotifications}
            />
            {onQuickActionsClick && (
              <Button
                type="button"
                onClick={onQuickActionsClick}
                aria-label={t("Quick actions", "Acciones rápidas")}
                aria-expanded={quickActionOpen}
                aria-controls={quickActionOpen ? "velora-quick-menu" : undefined}
                title={t("Quick actions", "Acciones rápidas")}
                variant="ghost"
                size="icon"
                className="dashboard-quick-action"
                data-active={quickActionOpen ? "true" : undefined}
              >
                <MoreVertical size={18} aria-hidden strokeWidth={1.8} />
              </Button>
            )}
          </div>
        </header>

        <div className="dashboard-main-area">
          <main id="main-content" className="app-main dashboard-main">
            <div className="page-shell dashboard-page-shell">
              <div
                className="scrollbar-none"
                style={{ overflowY: contentScrollable ? "auto" : "hidden", height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}
              >
                {children}
              </div>
            </div>
          </main>
        </div>

        <div data-print-hide>{bottomNav}</div>
      </SidebarInset>
    </SidebarProvider>
  );
}
