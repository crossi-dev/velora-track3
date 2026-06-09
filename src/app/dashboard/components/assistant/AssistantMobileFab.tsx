"use client";

import { Plus } from "@phosphor-icons/react";

interface AssistantMobileFabProps {
  onManualSale: () => void;
  t: (en: string, es: string) => string;
}

export function AssistantMobileFab({ onManualSale, t }: AssistantMobileFabProps) {
  return (
    <div style={{ position: "absolute", right: 16, bottom: 72, zIndex: "var(--z-toast)" as unknown as number, pointerEvents: "none" }}>
      <button
        type="button"
        aria-label={t("New sale", "Nueva venta")}
        onClick={onManualSale}
        className="assistant-mobile-sale-fab"
        style={{
          width: "56px",
          height: "56px",
          borderRadius: "9999px",
          border: "none",
          backgroundColor: "var(--brand)",
          color: "#FFFFFF",
          boxShadow: "0 4px 12px rgba(27,58,107,0.35)",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          cursor: "pointer",
          pointerEvents: "auto",
        }}
      >
        <Plus size={24} weight="bold" />
      </button>
    </div>
  );
}
