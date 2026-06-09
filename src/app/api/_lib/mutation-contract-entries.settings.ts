// Mutation-contract entries for Settings UI owner-admin routes.
//
// Split from mutation-contract-entries.ts to keep that module under the
// hard limit of 300 LOC (project conventions). Pattern mirrors
// mutation-contract-entries.integrations.ts.
//
// Covers: CSV/XLSX bulk import via the Settings → Import card
// (upload-file/execute endpoint — preview step is stateless, execute step
// does the write and requires audit + idempotency).

import type { MutationContractEntry } from "./mutation-contract-types";

export const SETTINGS_MUTATION_CONTRACT = {
  "upload-file-execute.create": {
    actionType: "upload-file-execute.create",
    routeScope: "upload-file/execute",
    resourceType: "import",
    requiresTrace: true,
    requiresIdempotency: true,
    idempotencyStrategy: "derived",
    compositeChildren: ["product.upsert", "customer.upsert", "inventory.adjust"],
  },
} as const satisfies Record<string, MutationContractEntry>;
