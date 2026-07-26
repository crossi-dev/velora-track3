// role-contract.ts — single source of truth for Velora roles and agents.
//
// Exactly one role. Exactly one agent for it.
// Everything else in the system imports from here — never redefines.
//
// If this changes, it changes once here and TypeScript propagates the error
// to any location that has diverged.
//
// Employee role removed (0 rows in production, Stage 1 cleanup; Stage 2
// removed the remaining owner/employee branches from shared code). The live
// companion-agent RPC path (src/app/api/agents/companion/**, rbac-policy.ts)
// models a "companion" actor kind as a plain string; canRoleExecuteIntent()'s
// parameter is typed `string` (not `Role`) so it stays compatible with that
// caller without reintroducing "companion" into the canonical Role type.

// ─── Roles ───────────────────────────────────────────────────────────────────

export const ROLES = ["owner"] as const;
export type Role = (typeof ROLES)[number];

// ─── Agent per role ──────────────────────────────────────────────────────────

export const AGENT_FOR_ROLE = {
  owner: "supervisor",
} as const satisfies Record<Role, string>;

export type AgentName = (typeof AGENT_FOR_ROLE)[Role];

// ─── Owner-only intents: enumerable list for UI / companion summaries ────────
//
// This set is the canonical list of intents that only the owner is allowed to
// execute. Only the owner can act now, so `canRoleExecuteIntent("owner", x)`
// always allows every intent — this set remains as the enumerable reference
// for UI/prompt summaries and for the legacy companion-agent RPC gate below.
//
// USAGE RULES (post 2026-05-23 cleanup):
// - For RUNTIME permission checks, ALWAYS call `canRoleExecuteIntent(role, intent)`.
//   That function is derived from COMPANION_ALLOWED_INTENTS and stays in sync
//   even when new intents are added.
// - For ENUMERATING the blocked set (companion-rules-summary, rbac-policy
//   re-export, debug pages), this set IS the right reference. It does not drift
//   as long as new owner-only intents are added here AND new companion-allowed
//   intents go to COMPANION_ALLOWED_INTENTS — same author, same PR, same review.
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

// ─── RBAC: explicit allowlist for the live companion-agent RPC path ─────────
//
// New intents default to OWNER-ONLY unless added here. There is no employee
// role in the live app anymore (resolveActor() only ever returns "owner");
// this set is consulted by the companion-agent RPC gate
// (src/app/api/agents/companion/**, via rbac-policy.ts).

const COMPANION_ALLOWED_INTENTS: ReadonlySet<string> = new Set([
  "answer",
  "register_sale",
  "stock_load",
  "business_query",
  "report_event",
  // cobro_qr: companion users are the primary point-of-sale actors — they need to
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
// actorEmployeeId is always null now (no employee role) — kept as an
// always-null field because logging/audit call sites across the codebase
// still pass it through; see resolve-actor.ts.

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
//
// `role` is typed `string` (not `Role`) so the companion-agent RPC
// path (which models a "companion" actor kind, see COMPANION_ALLOWED_INTENTS
// above) keeps compiling against this guard without reintroducing "companion"
// into the canonical Role type used by the owner path.

export function canRoleExecuteIntent(role: string, intent: string): boolean {
  if (role === "owner") return true;
  return COMPANION_ALLOWED_INTENTS.has(intent);
}
