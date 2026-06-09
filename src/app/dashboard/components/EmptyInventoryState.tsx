"use client";

import { SharedEmptyState } from "./SharedEmptyState";
import { useT } from "../lib/DashboardLangContext";

interface EmptyInventoryStateProps {
  onAddProduct?: () => void;
}

// Branded inventory illustration: abstract box + spark mark, brand-tinted.
function InventoryIllustration() {
  return (
    <svg
      width="56"
      height="56"
      viewBox="0 0 56 56"
      fill="none"
      aria-hidden
      style={{ color: "var(--brand)" }}
    >
      <defs>
        <linearGradient id="empty-inv-grad" x1="0" y1="0" x2="56" y2="56" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="currentColor" stopOpacity="0.95" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0.65" />
        </linearGradient>
      </defs>
      {/* Soft background halo */}
      <circle cx="28" cy="28" r="22" stroke="currentColor" strokeOpacity="0.14" strokeWidth="1.5" strokeDasharray="3 5" />
      {/* Box body */}
      <path
        d="M14 20 L28 13 L42 20 L42 38 L28 45 L14 38 Z"
        fill="url(#empty-inv-grad)"
        fillOpacity="0.18"
        stroke="url(#empty-inv-grad)"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      {/* Box fold lines */}
      <path d="M14 20 L28 27 L42 20" stroke="currentColor" strokeOpacity="0.55" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M28 27 L28 45" stroke="currentColor" strokeOpacity="0.55" strokeWidth="1.5" />
      {/* Spark accent */}
      <path d="M44 12 L45.2 15.8 L49 17 L45.2 18.2 L44 22 L42.8 18.2 L39 17 L42.8 15.8 Z" fill="currentColor" fillOpacity="0.85" />
    </svg>
  );
}

export function EmptyInventoryState({ onAddProduct }: EmptyInventoryStateProps = {}) {
  const t = useT();

  if (!onAddProduct) {
    // Employee view: no permission to add products — show guidance instead of a dead-end.
    return (
      <SharedEmptyState
        illustration={<InventoryIllustration />}
        title={t("No products loaded yet", "Aún no cargaste productos")}
        description={t(
          "Ask the owner to add products so you can start selling.",
          "Pedile al dueño que cargue productos para poder empezar a vender."
        )}
      />
    );
  }

  return (
    <SharedEmptyState
      illustration={<InventoryIllustration />}
      title={t("No products loaded yet", "Aún no cargaste productos")}
      description={t(
        "Start by adding your first product. We help you record stock, prices and sales in seconds.",
        "Empezá agregando tu primer producto. Te ayudamos a registrar stock, precios y ventas en segundos."
      )}
      action={{ label: t("Add product", "Agregar producto"), onClick: onAddProduct }}
    />
  );
}
