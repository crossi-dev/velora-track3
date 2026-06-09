// Activity Collector — tracks which agents participated in a single chat turn.
//
// Usage: create one collector per turn, pass it to any code that invokes
// sub-agents, then call toArray() to get the serializable payload for the
// response. All methods are synchronous and mutation-free externally.
//
// This is intentionally thin — the collector does NOT do I/O. Callers
// handle timing and the collector just stores the entries.

export interface AgentActivity {
  agentId: string;   // machine-readable id: "vertex-search", "payments", etc.
  agentLabel: string; // human-readable: "Vertex AI Search", "Payments Agent", etc.
  action: string;    // past-tense description: "catálogo consultado", "QR generado"
  latencyMs: number;
  icon: string;      // emoji used in the UI bubble
}

// ── Agent metadata registry ──────────────────────────────────────────────────

const AGENT_META: Record<string, { label: string; icon: string }> = {
  "vertex-search":   { label: "Vertex AI Search",    icon: "🔗" },
  "payments":        { label: "Payments Agent",       icon: "💳" },
  "fiscal":          { label: "Fiscal Agent",         icon: "📄" },
  "andreani":        { label: "Andreani Agent",       icon: "📦" },
};

function getMeta(agentId: string): { label: string; icon: string } {
  return AGENT_META[agentId] ?? { label: agentId, icon: "⚙️" };
}

// ── Collector class ──────────────────────────────────────────────────────────

export class ActivityCollector {
  private readonly entries: AgentActivity[] = [];

  add(agentId: string, action: string, latencyMs: number): void {
    const { label, icon } = getMeta(agentId);
    this.entries.push({ agentId, agentLabel: label, action, latencyMs, icon });
  }

  toArray(): AgentActivity[] {
    return this.entries.slice();
  }

  isEmpty(): boolean {
    return this.entries.length === 0;
  }
}

// ── Derive activity from supervisor actions (post-execution) ─────────────────
//
// For agents that are mocked (payments, fiscal, Andreani), we infer
// activity from the actions the supervisor emitted rather than instrumenting
// each mock individually. This is correct for demo mode and avoids coupling
// the collector to every mock implementation.

type SupervisorAction = { intent: string; data?: unknown };

export function deriveActivityFromActions(
  actions: SupervisorAction[],
  latencyMs: number,
): AgentActivity[] {
  const collector = new ActivityCollector();

  for (const a of actions) {
    switch (a.intent) {
      case "call_ventas_agent":
        collector.add("payments", "QR de cobro generado", latencyMs);
        break;
      case "call_contador_agent":
        collector.add("fiscal", "factura ARCA procesada", latencyMs);
        break;
      case "call_andreani_agent":
      case "create_shipment":
        collector.add("andreani", "envío cotizado/creado", latencyMs);
        break;
      default:
        break;
    }
  }

  return collector.toArray();
}
