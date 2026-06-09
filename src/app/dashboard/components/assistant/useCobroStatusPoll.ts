"use client";

// Polling hook para la card de Cobro QR.
//
// Mientras la card está "pending" el hook pega a GET /api/payment-intents/status
// cada 4s. Cuando el server reporta estado="confirmed" dispara onConfirmed()
// — el componente padre lo usa para flipear la card a la vista "Cobrado" sin
// requerir que el empleado toque "Marcar cobrado" manualmente.
//
// Se detiene solo cuando:
//   - El status pasa a "confirmed" (terminal — onConfirmed se invoca 1 vez).
//   - El status pasa a "expired" / "cancelled" (terminal — onTerminal opcional).
//   - El componente desmonta o `enabled` pasa a false.
//
// Falla silencioso. Un 404/500/timeout no propaga ni mata el polling: el
// próximo tick reintenta. El countdown de expiración corre en paralelo en
// useCobroExpiryCountdown y es la red de seguridad si el webhook nunca llega.

import { useEffect, useRef } from "react";

const POLL_INTERVAL_MS = 4_000;
const FETCH_TIMEOUT_MS = 5_000;

interface UseCobroStatusPollOptions {
  paymentIntentId: string;
  enabled: boolean;
  onConfirmed: () => void;
  onTerminal?: (estado: "expired" | "cancelled") => void;
}

interface StatusResponse {
  paymentIntentId?: string;
  estado?: string;
}

async function fetchStatus(paymentIntentId: string): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(
      `/api/payment-intents/status?id=${encodeURIComponent(paymentIntentId)}`,
      { signal: controller.signal, credentials: "same-origin" },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as StatusResponse;
    return typeof body.estado === "string" ? body.estado : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export function useCobroStatusPoll(opts: UseCobroStatusPollOptions): void {
  const onConfirmedRef = useRef(opts.onConfirmed);
  const onTerminalRef = useRef(opts.onTerminal);
  onConfirmedRef.current = opts.onConfirmed;
  onTerminalRef.current = opts.onTerminal;

  useEffect(() => {
    if (!opts.enabled || !opts.paymentIntentId) return;
    let cancelled = false;

    const tick = async () => {
      if (cancelled) return;
      const estado = await fetchStatus(opts.paymentIntentId);
      if (cancelled || !estado) return;
      if (estado === "confirmed") {
        // Cancel immediately so no further tick fires after onConfirmed.
        cancelled = true;
        onConfirmedRef.current();
        return;
      }
      if (estado === "expired" || estado === "cancelled") {
        onTerminalRef.current?.(estado);
      }
    };

    // Eager poll on mount: hit the server immediately instead of waiting 4s.
    // Recovers the card when it re-renders from chat history (post-unmount)
    // and handles the expired→confirmed race without waiting for the next tick.
    void tick();

    const id = setInterval(() => { void tick(); }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [opts.enabled, opts.paymentIntentId]);
}
