"use client";

import { useEffect } from "react";
import { CloudSlash } from "@phosphor-icons/react";
import { toast } from "sonner";
import { useOfflineQueueStatus } from "../lib/hooks/useOfflineQueueStatus";
import { OFFLINE_QUEUED_EVENT } from "../lib/actions/offline-action-queue";

// Badge para el sidebar — muestra cuántas mutaciones quedaron en cola
// offline + un toast efímero cuando se acaba de encolar una. Si el
// browser está online y la queue está vacía, no renderiza nada.

export function OfflineQueueBadge({
  t,
}: {
  t: (en: string, es: string) => string;
}) {
  const { count, isOnline } = useOfflineQueueStatus();

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handler = () => {
      toast(t("Offline — saved, will sync when back online.", "Sin conexión — guardado, se envía cuando vuelvas online."), {
        id: "offline-queued",
        duration: 4000,
      });
    };
    window.addEventListener(OFFLINE_QUEUED_EVENT, handler);
    return () => window.removeEventListener(OFFLINE_QUEUED_EVENT, handler);
  }, [t]);

  // Nada que mostrar si online + queue vacía.
  if (count === 0 && isOnline) return null;

  const showOffline = !isOnline;
  const showCount = count > 0;

  if (!showOffline && !showCount) return null;

  return (
    <div
      aria-live="polite"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "6px",
        padding: "4px 10px",
        borderRadius: "999px",
        background: showOffline ? "rgba(220, 38, 38, 0.12)" : "rgba(234, 179, 8, 0.14)",
        color: showOffline ? "var(--danger, #dc2626)" : "var(--accent-amber, #b45309)",
        fontFamily: "var(--font-dm-sans)",
        fontSize: "0.875rem",
        fontWeight: 600,
        letterSpacing: "0.02em",
      }}
      title={showOffline
        ? t(`Offline. ${count} actions queued.`, `Sin conexión. ${count} acciones en cola.`)
        : t(`${count} pending actions to sync`, `${count} acciones pendientes de enviar`)
      }
    >
      <CloudSlash size={14} weight="bold" />
      {showOffline ? t("Offline", "Sin conexión") : null}
      {showCount ? <span>{count}</span> : null}
    </div>
  );
}
