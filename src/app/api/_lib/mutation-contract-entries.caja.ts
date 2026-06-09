// Mutation-contract entries for caja (cash-drawer) ADK tools.
//
// Split from mutation-contract-entries.ts to keep that module under the
// hard limit of 300 LOC (project conventions). Pattern mirrors
// mutation-contract-entries.settings.ts.
//
// These entries follow the orphan-server-entry pattern: mutations are executed
// inline inside ADK FunctionTools (createTool factory) — not via a public route
// handler. Coverage: beginIdempotentMutation + recordCriticalWriteEvent inside
// src/lib/adk/tools/caja-{ciclo,movimiento}-tool.ts.
//
// Source: Square CashDrawerShift API (verified HTTP 200 2026-06-02)
//   https://developer.squareup.com/reference/square/objects/CashDrawerShift
// Added: 2026-06-03 (caja tools pilot).

import type { MutationContractEntry } from "./mutation-contract-types";

export const CAJA_MUTATION_CONTRACT = {
  "caja.session.open": {
    actionType: "caja.session.open",
    routeScope: "caja/session/open",
    resourceType: "caja_session",
    requiresTrace: true,
    requiresIdempotency: true,
    idempotencyStrategy: "header",
  },
  "caja.session.close": {
    actionType: "caja.session.close",
    routeScope: "caja/session/close",
    resourceType: "caja_session",
    requiresTrace: true,
    requiresIdempotency: true,
    idempotencyStrategy: "header",
  },
  "caja.movement.create": {
    actionType: "caja.movement.create",
    routeScope: "caja/movements",
    resourceType: "cash_movement",
    requiresTrace: true,
    requiresIdempotency: true,
    idempotencyStrategy: "header",
  },
} as const satisfies Record<string, MutationContractEntry>;
