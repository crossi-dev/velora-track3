// Mutation-contract entries for third-party integration routes.
//
// Split from mutation-contract-entries.ts to keep that module under the
// hard limit of 300 LOC (CLAUDE.md). Pattern mirrors
// mutation-contract-entries.payment-intents.ts.
//
// Covers: Mercado Pago, ARCA/AFIP fiscal, MODO digital wallet.

import type { MutationContractEntry } from "./mutation-contract-types";

export const INTEGRATIONS_MUTATION_CONTRACT = {
  "mp_connection.connect_self_managed": {
    actionType: "mp_connection.connect_self_managed",
    routeScope: "integrations/mp/connect-token",
    resourceType: "mp_connection",
    requiresTrace: true,
    requiresIdempotency: true,
    idempotencyStrategy: "header",
  },
  "mp_connection.disconnect": {
    actionType: "mp_connection.disconnect",
    routeScope: "integrations/mp/disconnect",
    resourceType: "mp_connection",
    requiresTrace: true,
    requiresIdempotency: true,
    idempotencyStrategy: "header",
  },
  "arca_credential.upsert": {
    actionType: "arca_credential.upsert",
    routeScope: "integrations/fiscal/connect",
    resourceType: "arca_credential",
    requiresTrace: true,
    // Cert upload uses prisma.upsert — natural idempotency. The beginIdempotentMutation
    // pattern is not applicable to multipart/binary uploads; skip it.
    requiresIdempotency: false,
    idempotencyStrategy: "header",
  },
  "arca_credential.connect_delegation": {
    actionType: "arca_credential.connect_delegation",
    routeScope: "integrations/fiscal/connect-delegation",
    resourceType: "arca_credential",
    requiresTrace: true,
    // JSON upsert by businessId — natural idempotency; no beginIdempotentMutation needed.
    requiresIdempotency: false,
    idempotencyStrategy: "header",
  },
  "arca_credential.disconnect": {
    actionType: "arca_credential.disconnect",
    routeScope: "integrations/fiscal/disconnect",
    resourceType: "arca_credential",
    requiresTrace: true,
    requiresIdempotency: true,
    idempotencyStrategy: "header",
  },
  "modo_connection.upsert": {
    actionType: "modo_connection.upsert",
    routeScope: "integrations/modo/connect",
    resourceType: "modo_connection",
    requiresTrace: true,
    requiresIdempotency: false,
    idempotencyStrategy: "header",
  },
  "modo_connection.disconnect": {
    actionType: "modo_connection.disconnect",
    routeScope: "integrations/modo/disconnect",
    resourceType: "modo_connection",
    requiresTrace: true,
    requiresIdempotency: false,
    idempotencyStrategy: "header",
  },
  "courier_credential.disconnect": {
    actionType: "courier_credential.disconnect",
    routeScope: "integrations/logistica/disconnect",
    resourceType: "courier_credential",
    requiresTrace: true,
    requiresIdempotency: false,
    idempotencyStrategy: "header",
  },
  "waba_connection.connect": {
    actionType: "waba_connection.connect",
    routeScope: "integrations/whatsapp/connect",
    resourceType: "waba_connection",
    requiresTrace: true,
    // upsert by businessId (unique) — natural idempotency; no beginIdempotentMutation needed.
    requiresIdempotency: false,
    idempotencyStrategy: "header",
  },
  "waba_connection.disconnect": {
    actionType: "waba_connection.disconnect",
    routeScope: "integrations/whatsapp/connect",
    resourceType: "waba_connection",
    requiresTrace: true,
    requiresIdempotency: false,
    idempotencyStrategy: "header",
  },
  "channel_credential.upsert": {
    actionType: "channel_credential.upsert",
    routeScope: "integrations/comunicaciones/connect",
    resourceType: "channel_credential",
    requiresTrace: true,
    // upsert by (businessId, provider) unique constraint — natural idempotency.
    requiresIdempotency: false,
    idempotencyStrategy: "header",
  },
  "channel_credential.disconnect": {
    actionType: "channel_credential.disconnect",
    routeScope: "integrations/comunicaciones/disconnect",
    resourceType: "channel_credential",
    requiresTrace: true,
    requiresIdempotency: false,
    idempotencyStrategy: "header",
  },
} as const satisfies Record<string, MutationContractEntry>;
