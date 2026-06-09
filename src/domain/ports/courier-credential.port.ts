// courier-credential.port.ts — domain port for per-business courier credential loading.
//
// Branch-by-Abstraction seam (martinfowler.com/bliki/BranchByAbstraction.html):
//   Agent code depends on this interface, not the concrete DB loader.
//   The default adapter (courier-credential.adapter.ts) wraps the existing
//   courier-credential-loader.ts — no behavior change.
//   Future: a different adapter can load credentials via HTTP (core service)
//   without touching any agent logic.
//
// Security contract (inherited from the loader):
//   Decrypted credentials MUST NOT be logged, returned to clients, or stored
//   in memory beyond the scope of a single request.

import type {
  AndreaniCredentials,
  OcaCredentials,
  CorreoCredentials,
} from "@/infrastructure/courier/courier-credential-loader";

// Re-export credential shapes so port consumers don't reach into the infrastructure layer.
export type { AndreaniCredentials, OcaCredentials, CorreoCredentials };

export interface CourierCredentialPort {
  /**
   * Load per-business Andreani credentials.
   * Returns null when not configured (caller falls back to env vars).
   */
  loadAndreani(businessId: string): Promise<AndreaniCredentials | null>;

  /**
   * Load per-business OCA credentials.
   * Returns null when not configured (caller degrades gracefully).
   */
  loadOca(businessId: string): Promise<OcaCredentials | null>;

  /**
   * Load per-business Correo Argentino credentials.
   * Returns null when not configured (caller degrades gracefully).
   */
  loadCorreo(businessId: string): Promise<CorreoCredentials | null>;
}
