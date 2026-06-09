// mutation-contract-entries.catalogo.ts — Catalogo domain entries.
// Split from mutation-contract-entries.ts to stay under the 300-line limit.
// Same sibling pattern as mutation-contract-entries.supervisor.ts.
//
// Entries here are ADK tool-internal writes (catalogo.precios_por_tipo_cliente).
// They have no public route handler — contract coverage lives in the tool's
// execute function via beginIdempotentMutation + recordCriticalWriteEvent.
// Listed in INTENTIONAL_ORPHAN_SERVER_ENTRIES + SUPERVISOR_INTERNAL_ACTIONS
// in the guardrail scripts.

import type { MutationContractEntry } from "./mutation-contract-types";

export const CATALOGO_MUTATION_CONTRACT = {
  "catalogo.tier.upsert": {
    actionType: "catalogo.tier.upsert",
    routeScope: "catalogo/tiers",
    resourceType: "product_price_tier",
    requiresTrace: true,
    requiresIdempotency: true,
    idempotencyStrategy: "header",
    compositeChildren: ["product-price-tier-entry.upsert"],
  },
  "catalogo.tier.assign-customer": {
    actionType: "catalogo.tier.assign-customer",
    routeScope: "catalogo/tiers/assign",
    resourceType: "customer",
    requiresTrace: true,
    requiresIdempotency: true,
    idempotencyStrategy: "header",
  },
} as const satisfies Record<string, MutationContractEntry>;
