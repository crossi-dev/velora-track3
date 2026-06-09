// Audible feedback al confirmar un cobro QR / alias.
//
// Slice 4 del módulo Cobro QR (PRD §4 — "beep corto on by default,
// cultura AR del ka-ching de MP"). Two-tone beep (600Hz → 900Hz) generado
// con Web Audio API on-the-fly: cero assets, cero deps externas.
//
// Reglas:
//   - SSR-safe: no-op si `window` no existe.
//   - Respeta `prefers-reduced-motion: reduce` — ese setting cubre también
//     reducción de feedback sensorial, no solo animaciones.
//   - Volumen subtle (gain 0.15) — no debe asustar al cliente al lado.
//   - Errores silenciosos: jamás throws, jamás bloquea el confirm flow del
//     cobro (es accesorio sensorial, no crítico).
//   - AudioContext lazy: se crea en la primera llamada. El click en
//     "Marcar cobrado" cuenta como user gesture, así que browsers modernos
//     permiten arrancar el contexto sin warnings.
//
// Compat: WebKit todavía expone `webkitAudioContext`. Cubrimos ambos.
//
// Hard limit del archivo: 100 LOC.

interface AudioContextWindow extends Window {
  webkitAudioContext?: typeof AudioContext;
}

let cachedContext: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (cachedContext) return cachedContext;
  const w = window as AudioContextWindow;
  const Ctor = window.AudioContext ?? w.webkitAudioContext;
  if (!Ctor) return null;
  cachedContext = new Ctor();
  return cachedContext;
}

function scheduleTone(
  ctx: AudioContext,
  frequencyHz: number,
  startAt: number,
  durationSec: number,
): void {
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  oscillator.type = "sine";
  oscillator.frequency.value = frequencyHz;
  // Volumen subtle. Pequeño ramp-out para no clickear al cortar.
  gain.gain.value = 0.15;
  gain.gain.setValueAtTime(0.15, startAt + durationSec - 0.02);
  gain.gain.linearRampToValueAtTime(0, startAt + durationSec);
  oscillator.connect(gain);
  gain.connect(ctx.destination);
  oscillator.start(startAt);
  oscillator.stop(startAt + durationSec);
}

export function playConfirmBeep(): void {
  if (typeof window === "undefined") return;
  try {
    if (
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }
    const ctx = getAudioContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    // Two-tone: low (600Hz, 90ms) → high (900Hz, 110ms). Total ~200ms.
    scheduleTone(ctx, 600, now, 0.09);
    scheduleTone(ctx, 900, now + 0.09, 0.11);
  } catch {
    // Audio is best-effort; errores nunca burbujean al caller.
  }
}

/**
 * Confirm feedback: audible ka-ching + short haptic (50ms vibration).
 * Use this instead of calling playConfirmBeep directly so all confirm
 * call sites stay in sync. Both effects are best-effort and SSR-safe.
 */
export function triggerConfirmFeedback(): void {
  playConfirmBeep();
  if (typeof navigator !== "undefined" && "vibrate" in navigator) {
    navigator.vibrate(50);
  }
}

// Solo expuesto para tests — permite resetear el cache del context entre runs.
export function __resetAudioContextForTests(): void {
  cachedContext = null;
}
