// OIDC token verification for the whatsapp-inbound Cloud Tasks worker.
// Delegates to the shared makeTasksOidcVerifier factory in internal/_lib/oidc-verifiers.ts.
// Ref: https://cloud.google.com/tasks/docs/creating-http-target-tasks#token

import { makeTasksOidcVerifier } from "@/app/api/internal/_lib/oidc-verifiers";

export const verifyOidcToken = makeTasksOidcVerifier({
  audiencePath: "/api/internal/tasks/whatsapp-inbound",
  logComponent: "WhatsApp",
  logAction: "TASK_WPP_OIDC_SA_UNVERIFIED",
  taskName: "whatsapp-inbound",
});
