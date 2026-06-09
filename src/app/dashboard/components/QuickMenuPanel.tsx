"use client";

import { TruckIcon, ReceiptIcon, GearSixIcon, SignOutIcon, UsersIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { handleSignOut } from "@/lib/handle-sign-out";
import type { TabKey, QuickActionMode } from "../lib/types";

interface QuickMenuPanelProps {
  setActiveTab: (tab: TabKey) => void;
  setQuickAction: (action: QuickActionMode) => void;
  t: (en: string, es: string) => string;
}

export function QuickMenuPanel({ setActiveTab, setQuickAction, t }: QuickMenuPanelProps) {
  return (
    <div
      id="velora-quick-menu"
      className="rounded-token-xl quick-menu-panel"
      style={{
        position: "fixed",
        top: "calc(var(--nav-top-height) + 4px)",
        right: "8px",
        width: "220px",
        backgroundColor: "var(--surface)",
        border: "1px solid var(--border)",
        boxShadow: "var(--shadow-md)",
        zIndex: "var(--z-tooltip)" as unknown as number, /* above toast (--z-toast), below overlay (--z-overlay) */
        overflow: "hidden",
        animation: "menuPop 200ms cubic-bezier(0.22, 1, 0.36, 1)",
      }}
    >
      <div className="flex flex-col py-1.5">
        {/* Presupuestos ENCAJONADO 2026-05-25 — restore by uncommenting this block.
        <Button
          variant="ghost"
          onClick={() => { setActiveTab("budget"); setQuickAction(null); }}
          className="flex items-center justify-start gap-3 px-4 py-3 w-full rounded-none"
        >
          <Notepad className="icon-base text-[var(--tone-muted)]" />
          <span className="text-body">{t("Quotes", "Presupuestos")}</span>
        </Button>
        */}

        <Button
          variant="ghost"
          onClick={() => { setActiveTab("suppliers"); setQuickAction(null); }}
          className="flex items-center justify-start gap-3 px-4 py-3 w-full rounded-none"
        >
          <TruckIcon className="icon-base text-[var(--tone-muted)]" />
          <span className="text-body">{t("Suppliers", "Proveedores")}</span>
        </Button>

        <Button
          variant="ghost"
          onClick={() => { setActiveTab("clients"); setQuickAction(null); }}
          className="flex items-center justify-start gap-3 px-4 py-3 w-full rounded-none"
        >
          <UsersIcon className="icon-base text-[var(--tone-muted)]" />
          <span className="text-body">{t("Clients", "Clientes")}</span>
        </Button>

        <Button
          variant="ghost"
          onClick={() => { setActiveTab("invoices"); setQuickAction(null); }}
          className="flex items-center justify-start gap-3 px-4 py-3 w-full rounded-none"
        >
          <ReceiptIcon className="icon-base text-[var(--tone-muted)]" />
          <span className="text-body">{t("Invoices", "Facturas")}</span>
        </Button>

        <Button
          variant="ghost"
          onClick={() => { setActiveTab("settings"); setQuickAction(null); }}
          className="flex items-center justify-start gap-3 px-4 py-3 w-full rounded-none"
        >
          <GearSixIcon className="icon-base text-[var(--tone-muted)]" />
          <span className="text-body">{t("Settings", "Ajustes")}</span>
        </Button>
        <div className="mx-4 my-2 h-px opacity-0" aria-hidden />
        <Button
          variant="ghost"
          onClick={() => { void handleSignOut(); }}
          className="flex items-center justify-start gap-3 px-4 py-3 w-full rounded-none text-[var(--danger)] hover:text-[var(--danger)] hover:bg-[var(--danger-soft)]"
        >
          <SignOutIcon className="icon-base" />
          <span className="text-body-strong font-bold">{t("Sign out", "Cerrar sesión")}</span>
        </Button>
      </div>
      <style jsx>{`
        @keyframes menuPop {
          from { opacity: 0; transform: scale(0.95) translateY(-10px); }
          to { opacity: 1; transform: scale(1) translateY(0); }
        }

        @media (prefers-reduced-motion: reduce) {
          @keyframes menuPop {
            from { opacity: 0; }
            to   { opacity: 1; }
          }
        }

        @media (max-width: 767px) {
          .quick-menu-panel {
            top: calc(var(--nav-top-height-mobile) + max(4px, env(safe-area-inset-top, 0px)));
          }
        }

        /* Scope to separator/divider elements only.
           Inputs, selects, and buttons keep their shadcn borders and focus rings.
           Removing them globally violated WCAG 1.4.11 non-text contrast. */
        .quick-actions-no-lines :global(hr),
        .quick-actions-no-lines :global([role="separator"]) {
          border: none !important;
          box-shadow: none !important;
        }
      `}</style>
    </div>
  );
}
