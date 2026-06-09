"use client";

import { useEffect, useState } from "react";

// Thinking indicator with timed stages that cycle through labels as elapsed
// time advances — gives users reassurance during long Supervisor + A2A turns
// (Msg3 Payments chain can take 30-50s: NLU → Payments Agent → Andreani RPC
// → MP link generation → WhatsApp template).
//
// Stage rationale (Material Design 3 / NN/g async UX — see references below):
//   0-3s    : logo pulse only — below "perceived delay" threshold, no text needed
//   3-8s    : generic "thinking" label — Slow Path LLM warm-up
//   8-18s   : Andreani quote stage label — courier RPC window
//   18-35s  : MP link generation label — payment-intent creation window
//   35s+    : WhatsApp preparation label — template dispatch window
//
// References:
//   - Material Design 3 progress indicators with stage labels for >10s ops:
//     https://m3.material.io/components/progress-indicators/guidelines
//   - NN/g: Response Times — The 3 Important Limits:
//     https://www.nngroup.com/articles/response-times-3-important-limits/
//
// INTENTIONAL: labels are hardcoded Spanish for the AR-only demo. Post-demo
// i18n pass will wire these through the DashboardLangContext translation map.

interface ThinkingStage {
  minMs: number;
  label: string | null; // null = logo only, no text
}

const STAGES: ThinkingStage[] = [
  { minMs: 0, label: null },
  { minMs: 3000, label: "Velora está pensando..." },
  { minMs: 8000, label: "Cotizando envío con Andreani..." },
  { minMs: 18000, label: "Generando link de pago en MercadoPago..." },
  { minMs: 35000, label: "Preparando mensaje de WhatsApp..." },
];

const TICK_MS = 500;

export function ThinkingIndicator() {
  const [elapsedMs, setElapsedMs] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setElapsedMs((prev) => prev + TICK_MS);
    }, TICK_MS);
    return () => clearInterval(interval);
  }, []);

  // Resolve the current stage: last stage whose minMs <= elapsed
  const currentStage = STAGES.reduce<ThinkingStage>(
    (acc, stage) => (elapsedMs >= stage.minMs ? stage : acc),
    STAGES[0]
  );

  const label = currentStage.label;

  return (
    <>
      <div className="thinking-wrap" aria-live="polite" role="status">
        <div className="thinking-bubble">
          <img
            src="/velora-mark.svg"
            alt=""
            aria-hidden="true"
            width={24}
            height={24}
            className="thinking-mark"
          />
          {label !== null && (
            <span key={label} className="thinking-label">
              {label}
            </span>
          )}
        </div>
      </div>

      <style jsx>{`
        .thinking-wrap {
          display: flex;
          justify-content: flex-start;
        }

        .thinking-bubble {
          max-width: 20rem;
          border: 1px solid var(--border);
          border-radius: 1rem;
          background: var(--surface-subtle);
          padding: 0.75rem 1rem;
          display: flex;
          align-items: center;
          gap: 0.6rem;
        }

        .thinking-mark {
          width: 24px;
          height: 24px;
          flex-shrink: 0;
          animation: thinking-pulse 1.2s var(--ease-out, cubic-bezier(0, 0, 0.2, 1)) infinite;
          border-radius: 6px;
        }

        .thinking-label {
          font-size: 0.875rem;
          line-height: 1.3;
          color: var(--tone-muted);
          font-style: italic;
          animation: thinking-fade-in 0.25s ease-out;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        @keyframes thinking-pulse {
          0%,
          100% {
            transform: scale(0.95);
            opacity: 0.8;
          }

          50% {
            transform: scale(1.05);
            opacity: 1;
          }
        }

        @keyframes thinking-fade-in {
          from {
            opacity: 0;
            transform: translateX(-4px);
          }
          to {
            opacity: 1;
            transform: translateX(0);
          }
        }

        @media (prefers-reduced-motion: reduce) {
          .thinking-mark {
            animation: none;
            opacity: 0.8;
          }
          .thinking-label {
            animation: none;
          }
        }
      `}</style>
    </>
  );
}
