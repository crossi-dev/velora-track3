// courier-credential.adapter.ts — default implementation of CourierCredentialPort.
//
// Delegates to the existing courier-credential-loader.ts (DB + decryption).
// No behavior change — this is purely a wrapper introducing the port seam.
//
// Usage: import { getCourierCredentialPort } from this module to get the singleton
// default adapter.  Inject a different implementation in tests or future extractors.

import {
  loadAndreaniCredentials,
  loadOcaCredentials,
  loadCorreoCredentials,
} from "@/infrastructure/courier/courier-credential-loader";
import type { CourierCredentialPort } from "@/domain/ports/courier-credential.port";

const defaultAdapter: CourierCredentialPort = {
  loadAndreani: (businessId) => loadAndreaniCredentials(businessId),
  loadOca:      (businessId) => loadOcaCredentials(businessId),
  loadCorreo:   (businessId) => loadCorreoCredentials(businessId),
};

/**
 * Returns the default CourierCredentialPort implementation.
 * Backed by the DB loader (courier-credential-loader.ts).
 * Replace in tests by passing a different implementation to call sites directly.
 */
export function getCourierCredentialPort(): CourierCredentialPort {
  return defaultAdapter;
}
