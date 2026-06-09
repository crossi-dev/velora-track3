// OIDC token verification for the onboarding-nudge Cloud Tasks worker.
// Delegates to the shared makeTasksOidcVerifier factory in internal/_lib/oidc-verifiers.ts.
// Mirrors: whatsapp-inbound/_lib/verify-oidc-token.ts (same factory, different audiencePath).
// Ref: https://cloud.google.com/tasks/docs/creating-http-target-tasks#token

import { makeTasksOidcVerifier } from "@/app/api/internal/_lib/oidc-verifiers";

export const verifyOidcToken = makeTasksOidcVerifier({
  audiencePath: "/api/internal/tasks/onboarding-nudge",
  logComponent: "System",
  logAction: "TASK_ONBOARDING_NUDGE_OIDC_SA_UNVERIFIED",
  taskName: "onboarding-nudge",
});
