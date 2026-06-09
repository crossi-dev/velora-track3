// Latency tracker para /api/business-assistant — emite Cloud Logging
// estructurado al final de cada request con timing por fase.
//
// Por qué archivo separado: la trace existente (`trace.ts`) es dev-only
// y no piping a Cloud Logging. Acá medimos en producción para sacar datos
// reales — qué fase consume tiempo, qué % del tráfico hit pre-AI dispatch
// vs full LLM, qué intents son comunes.
//
// Output ejemplo (Cloud Logging):
//   { severity: "INFO", action: "ASSISTANT_CHAT_LATENCY", a2a_transfer: false,
//     data: { totalMs: 1234, preAiMs: 12, modelMs: 1180, postModelMs: 42,
//             intent: "register_sale", path: "model" }, businessId, ... }

import { cloudLog } from "@/lib/cloud-logger";

interface PhaseTiming {
  name: string;
  durationMs: number;
}

export interface LatencyTracker {
  /** Marca el comienzo de una fase. La duración va de start() a end() del nombre. */
  start: (phaseName: string) => void;
  end: (phaseName: string) => void;
  /** Registra metadata para el log final (intent, path, ...). */
  setMeta: (key: string, value: unknown) => void;
  /** Emite el log estructurado. Llamar exactamente una vez por request. */
  emit: (args: { businessId: string; actorUserId?: string; actorEmployeeId?: string | null }) => void;
}

export function createLatencyTracker(actorRole: "owner" | "employee" = "employee"): LatencyTracker {
  const requestStart = Date.now();
  const phaseStarts = new Map<string, number>();
  const completed: PhaseTiming[] = [];
  const meta: Record<string, unknown> = {};
  let emitted = false;

  return {
    start(phaseName) {
      phaseStarts.set(phaseName, Date.now());
    },
    end(phaseName) {
      const begin = phaseStarts.get(phaseName);
      if (begin === undefined) return;
      completed.push({ name: phaseName, durationMs: Date.now() - begin });
      phaseStarts.delete(phaseName);
    },
    setMeta(key, value) {
      meta[key] = value;
    },
    emit({ businessId, actorUserId, actorEmployeeId }) {
      if (emitted) return;
      emitted = true;
      const totalMs = Date.now() - requestStart;
      const phaseMs: Record<string, number> = {};
      for (const p of completed) phaseMs[p.name] = p.durationMs;
      cloudLog({
        severity: "INFO",
        component: actorRole === "owner" ? "Owner" : "Employee",
        action: "ASSISTANT_CHAT_LATENCY",
        a2a_transfer: false,
        message: `assistant chat handled in ${totalMs}ms (${meta.path ?? "unknown"})`,
        data: { totalMs, phaseMs, ...meta },
        businessId,
        actorUserId,
        actorEmployeeId: actorEmployeeId ?? undefined,
      });
    },
  };
}
