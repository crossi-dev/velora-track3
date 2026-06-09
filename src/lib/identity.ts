// Identity layer — single entry point for authentication and authorization.
//
// Authentication (who are you?): resolveActor()
// Authorization (what can you do?): requireRole(), assertRole(), canRoleExecuteIntent()
//
// All routes and services import from here, not from api/_lib/resolve-actor directly.

export {
  resolveActor,
  requireRole,
  assertRole,
} from "@/app/api/_lib/resolve-actor";

export type { ActorRole, ActorContext } from "@/domain";
export { canRoleExecuteIntent } from "@/domain";
