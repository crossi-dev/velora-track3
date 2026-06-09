"use client";

// Countdown hook para la card del Cobro QR (slice 3 — timeout 2 min).
//
// Recibe el `expiresAt` ISO del server y devuelve { remainingMs, expired,
// label }. El label viene formateado "M:SS" listo para renderizar (ej. "1:47").
//
// Internamente arranca un setInterval(1000ms) que se limpia en unmount o si
// `expiresAt` cambia (cuando el empleado regenera el cobro). Si `expiresAt`
// es null (rows legacy pre-migration), devuelve `expired: false` y label
// vacío — el caller skip-ea la UI del countdown.
//
// El hook NO toma decisiones de UI: solo expone el reloj. Disable de botones
// y switch de copy quedan en el componente para mantener la lógica visible.

import { useEffect, useState } from "react";

export interface CobroExpiryClock {
  remainingMs: number;
  expired: boolean;
  label: string;
  hasTimeout: boolean;
}

function formatLabel(remainingMs: number): string {
  const totalSec = Math.max(0, Math.ceil(remainingMs / 1000));
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${String(sec).padStart(2, "0")}`;
}

function computeRemaining(expiresAt: string | null, now: number): number {
  if (!expiresAt) return 0;
  const t = Date.parse(expiresAt);
  if (Number.isNaN(t)) return 0;
  return t - now;
}

export function useCobroExpiryCountdown(
  expiresAt: string | null,
  options: { onExpire?: () => void } = {},
): CobroExpiryClock {
  const hasTimeout = Boolean(expiresAt);
  const [remainingMs, setRemainingMs] = useState<number>(() =>
    computeRemaining(expiresAt, Date.now()),
  );

  useEffect(() => {
    if (!expiresAt) {
      setRemainingMs(0);
      return;
    }
    setRemainingMs(computeRemaining(expiresAt, Date.now()));
    const id = setInterval(() => {
      const next = computeRemaining(expiresAt, Date.now());
      setRemainingMs(next);
      if (next <= 0) {
        clearInterval(id);
        options.onExpire?.();
      }
    }, 1000);
    return () => clearInterval(id);
    // onExpire intencionalmente fuera de deps: el caller lo memoiza si quiere
    // estabilidad; cambiar deps acá causaría restarts innecesarios del timer.
  }, [expiresAt]);

  const expired = hasTimeout && remainingMs <= 0;
  const label = hasTimeout ? formatLabel(remainingMs) : "";

  return { remainingMs, expired, label, hasTimeout };
}
