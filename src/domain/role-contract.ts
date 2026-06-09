// role-contract.ts — single source of truth for Velora roles and agents.
//
// Exactly two roles. Exactly one agent per role.
// Everything else in the system imports from here — never redefines.
//
// If this changes, it changes once here and TypeScript propagates the error
// to any location that has diverged.

// ─── Roles ───────────────────────────────────────────────────────────────────

export const ROLES = ["owner", "employee"] as const;
export type Role = (typeof ROLES)[number];

// ─── Agent per role ──────────────────────────────────────────────────────────

export const AGENT_FOR_ROLE = {
  owner: "supervisor",
  employee: "companion",
} as const satisfies Record<Role, string>;

export type AgentName = (typeof AGENT_FOR_ROLE)[Role];

// ─── Owner-only intents: enumerable list for UI / companion summaries ────────
//
// This set is the canonical list of intents that ONLY the owner is allowed to
// execute. The employee may emit these (the LLM detects them the same way),
// but the gate rejects them with a warm message before dispatch.
//
// USAGE RULES (post 2026-05-23 cleanup):
// - For RUNTIME permission checks, ALWAYS call `canRoleExecuteIntent(role, intent)`.
//   That function is derived from EMPLOYEE_ALLOWED_INTENTS and stays in sync
//   even when new intents are added.
// - For ENUMERATING the blocked set (companion-rules-summary, rbac-policy
//   re-export, debug pages), this set IS the right reference. It does not drift
//   as long as new owner-only intents are added here AND new employee-allowed
//   intents go to EMPLOYEE_ALLOWED_INTENTS — same author, same PR, same review.
// - Do NOT add `if (OWNER_ONLY_INTENTS.has(x))` as a guard. Use canRoleExecuteIntent.

export const OWNER_ONLY_INTENTS: ReadonlySet<string> = new Set([
  "edit_product",
  "delete_product",
  "bulk_price_update",
  "create_supplier",
  "edit_supplier",
  "delete_supplier",
  "adjust_stock",
  "stock_adjustment",
  "register_movement",
  "edit_customer",
  "delete_customer",
  "create_product",
  "create_budget",
  "return_sale",
  "create_customer",
  "create_purchase_request",
]);

// ─── RBAC: explicit allowlist for employees ───────────────────────────────────
//
// New intents default to OWNER-ONLY unless added here.
// Franchise model: employees only operate the register — no supplier/customer mgmt.

const EMPLOYEE_ALLOWED_INTENTS: ReadonlySet<string> = new Set([
  "answer",
  "register_sale",
  "stock_load",
  "business_query",
  "report_event",
  // cobro_qr: employees are the primary point-of-sale actors — they need to
  // charge via QR or alias. Opened 2026-05-11 (demo viernes invariant).
  "cobro_qr",
]);

// ─── High-risk gate ──────────────────────────────────────────────────────────
//
// Supervisor intents (returned by the LLM) that map to destructive or
// irreversible client-side actions. The owner handler intercepts these and
// returns a `confirmationRequest` instead of executing immediately.
// Note: "return_sale" (supervisor intent) maps to "undo" (CompoundAction type);
// HIGH_RISK_ACTION_TYPES uses the CompoundAction vocabulary.

export const HIGH_RISK_ACTION_TYPES: ReadonlySet<string> = new Set([
  "delete_product",
  "delete_supplier",
  "delete_customer",
  "bulk_price_update",
  "adjust_stock",
  "undo",            // return_sale intent
  "register_movement",
]);

// ─── Actor context ───────────────────────────────────────────────────────────
// Runtime identity of whoever is performing an action.
// actorUserId is always the business owner (required for audit).
// actorEmployeeId is null when the owner acts directly.

export interface ActorContext {
  businessId: string;
  actorUserId: string;
  actorEmployeeId: string | null;
  role: Role;
  /** True when the actor's email is in the tester allowlist. Server-only — never expose to client. */
  isTester?: boolean;
}

// Backwards-compatible alias used by UI layer.
export type ActorRole = Role;

// ─── Pure guard ──────────────────────────────────────────────────────────────

export function canRoleExecuteIntent(role: Role, intent: string): boolean {
  if (role === "owner") return true;
  return EMPLOYEE_ALLOWED_INTENTS.has(intent);
}
