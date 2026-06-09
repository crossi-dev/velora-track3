// Re-exported from domain — single source of truth.
// OWNER_ONLY_INTENTS is NOT re-exported; use canRoleExecuteIntent() instead.
export { ROLES, AGENT_FOR_ROLE, HIGH_RISK_ACTION_TYPES, canRoleExecuteIntent } from "@/domain/role-contract";
export type { Role, AgentName } from "@/domain/role-contract";
