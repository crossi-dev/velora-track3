// Eval suite schema for Velora agents.
// Read-only — referenced by scripts/eval-agents.mjs at runtime via JSON loading.

export type EvalAgent = "supervisor" | "companion" | "fiscal" | "payments";

export interface EvalContext {
  catalog?: Array<{ name: string; price?: number; stock?: number; costPrice?: number }>;
  activeRules?: Array<{ kind: "time-based" | "condition-based" | "behavior-based"; trigger: string; message: string }>;
  delegationPolicies?: Array<{ scope: string; maxValue: number | null; requiresOwner: boolean }>;
  employees?: Array<{ name: string }>;
  cashBalance?: number;
  currentTime?: string;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
}

export interface EvalExpectation {
  // Structural — supervisor uses kind/actions/clarification/answer/notification, companion uses intent/saleDraft/etc.
  // Runner does deep partial match: every key in `expected` must be present in actual response with matching value.
  // Use dot-paths in `match` for nested checks (e.g. "actions[0].intent": "register_sale").
  match: Record<string, string | number | boolean | null | object>;
  // Optional: assert that certain paths are absent (e.g. clarification must be null when actions present).
  absent?: string[];
}

export interface EvalCase {
  id: string;
  agent: EvalAgent;
  category: string;
  input: string;
  context?: EvalContext;
  expected: EvalExpectation;
  notes?: string;
}

export interface EvalSuite {
  metadata: {
    version: string;
    createdAt: string;
    framework: string;
    totalCases: number;
  };
  cases: EvalCase[];
}
