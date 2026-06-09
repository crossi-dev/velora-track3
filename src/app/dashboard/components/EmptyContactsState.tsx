"use client";

import { SharedEmptyState } from "./SharedEmptyState";
import { useT } from "../lib/DashboardLangContext";

interface EmptyContactsStateProps {
  onAddContact?: () => void;
}

// Branded contacts illustration: three abstract figures in a brand halo.
function ContactsIllustration() {
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
        <linearGradient id="empty-contacts-grad" x1="0" y1="0" x2="56" y2="56" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="currentColor" stopOpacity="0.95" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0.65" />
        </linearGradient>
      </defs>
      {/* Soft orbit */}
      <circle cx="28" cy="28" r="22" stroke="currentColor" strokeOpacity="0.14" strokeWidth="1.5" strokeDasharray="3 5" />
      {/* Center figure (large) */}
      <circle cx="28" cy="22" r="6.5" fill="url(#empty-contacts-grad)" />
      <path
        d="M15 44 Q15 34 28 34 Q41 34 41 44 Z"
        fill="url(#empty-contacts-grad)"
        fillOpacity="0.85"
      />
      {/* Left figure (small) */}
      <circle cx="13" cy="26" r="4" fill="currentColor" fillOpacity="0.4" />
      <path d="M6 42 Q6 35 13 35 Q14 35 14.6 35.1" fill="currentColor" fillOpacity="0.3" />
      {/* Right figure (small) */}
      <circle cx="43" cy="26" r="4" fill="currentColor" fillOpacity="0.4" />
      <path d="M50 42 Q50 35 43 35 Q42 35 41.4 35.1" fill="currentColor" fillOpacity="0.3" />
    </svg>
  );
}

export function EmptyContactsState({ onAddContact }: EmptyContactsStateProps = {}) {
  const t = useT();
  return (
    <SharedEmptyState
      illustration={<ContactsIllustration />}
      title={t("Your contact list is empty", "Tu lista de contactos está vacía")}
      description={t(
        "Add customers and suppliers to record their details and send them receipts via WhatsApp.",
        "Agregá clientes y proveedores para registrar sus datos y mandarles comprobantes por WhatsApp."
      )}
      action={
        onAddContact
          ? { label: t("Add contact", "Agregar contacto"), onClick: onAddContact }
          : undefined
      }
    />
  );
}
