interface TraceEntry {
  step: string;
  detail: string;
  timestamp: number;
}

interface AssistantTrace {
  entries: TraceEntry[];
  add: (step: string, detail: string) => void;
  toJSON: () => Record<string, unknown> | null;
}

const IS_DEV = process.env.NODE_ENV === "development";

/**
 * Lightweight explanation trace for development mode only.
 * Records intent detection, product/customer matching, ambiguity reasons,
 * and clarification triggers so debugging doesn't require hunting across 20 files.
 *
 * In production, all methods are no-ops and toJSON returns null.
 */
export function createAssistantTrace(): AssistantTrace {
  if (!IS_DEV) {
    return {
      entries: [],
      add: () => {},
      toJSON: () => null,
    };
  }

  const entries: TraceEntry[] = [];

  return {
    entries,
    add(step: string, detail: string) {
      entries.push({ step, detail, timestamp: Date.now() });
    },
    toJSON() {
      if (entries.length === 0) return null;
      return {
        _trace: entries.map((e) => `[${e.step}] ${e.detail}`),
        _traceMs: entries.length > 1
          ? entries[entries.length - 1].timestamp - entries[0].timestamp
          : 0,
      };
    },
  };
}
