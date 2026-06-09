// Mutation-contract entries for actions the Supervisor (Gemini Pro) executes
// as a side-effect of an owner chat turn. They live in their own sibling
// because they don't have a public route handler (no MUTATION_ACTIONS const,
// no resolveActor) — the supervisor handler in src/app/api/supervisor/_lib/*
// wraps the Prisma write in beginIdempotentMutation + recordCriticalWriteEvent
// directly. Mismo patrón "orphan server entry" que employee.create y
// mp_connection.disconnect: la entrada existe en SERVER_MUTATION_CONTRACT
// para que requiresIdempotency/requiresTrace los cubran, pero no hay
// declaración de ruta y no aparecen en CANONICAL_ACTION_KEYS.
//
// Splitting esto fuera de mutation-contract-entries.ts mantiene a ese módulo
// bajo el hard limit de 300 LOC (CLAUDE.md).

import type { MutationContractEntry } from "./mutation-contract-types";

export const SUPERVISOR_INTERNAL_MUTATION_CONTRACT = {
  "employee.reset-pin": {
    actionType: "employee.reset-pin",
    routeScope: "supervisor.reset-employee-pin",
    resourceType: "Employee",
    requiresTrace: true,
    requiresIdempotency: true,
    idempotencyStrategy: "derived",
  },
  "business-rule.create": {
    actionType: "business-rule.create",
    routeScope: "supervisor.business-rule",
    resourceType: "BusinessRule",
    requiresTrace: true,
    requiresIdempotency: true,
    idempotencyStrategy: "derived",
  },
  "business-rule.update": {
    actionType: "business-rule.update",
    routeScope: "supervisor.business-rule",
    resourceType: "BusinessRule",
    requiresTrace: true,
    requiresIdempotency: true,
    idempotencyStrategy: "derived",
  },
  "business-rule.delete": {
    actionType: "business-rule.delete",
    routeScope: "supervisor.business-rule",
    resourceType: "BusinessRule",
    requiresTrace: true,
    requiresIdempotency: true,
    idempotencyStrategy: "derived",
  },
  "delegation-policy.create": {
    actionType: "delegation-policy.create",
    routeScope: "supervisor.delegation-policy",
    resourceType: "DelegationPolicy",
    requiresTrace: true,
    requiresIdempotency: true,
    idempotencyStrategy: "derived",
  },
  "delegation-policy.update": {
    actionType: "delegation-policy.update",
    routeScope: "supervisor.delegation-policy",
    resourceType: "DelegationPolicy",
    requiresTrace: true,
    requiresIdempotency: true,
    idempotencyStrategy: "derived",
  },
  "delegation-policy.delete": {
    actionType: "delegation-policy.delete",
    routeScope: "supervisor.delegation-policy",
    resourceType: "DelegationPolicy",
    requiresTrace: true,
    requiresIdempotency: true,
    idempotencyStrategy: "derived",
  },
  "business-setup.update": {
    actionType: "business-setup.update",
    routeScope: "supervisor.business-setup",
    resourceType: "Business",
    requiresTrace: true,
    requiresIdempotency: true,
    idempotencyStrategy: "derived",
  },
  "broadcast.send": {
    actionType: "broadcast.send",
    routeScope: "supervisor.broadcast",
    resourceType: "ChatMessage",
    requiresTrace: true,
    requiresIdempotency: true,
    idempotencyStrategy: "derived",
  },
  // Andreani Agent — shipment.create persists AndreaniShipment and is an audit-required write.
  // No public route handler; the Andreani Agent calls prisma directly inside shipment-create.ts
  // (same orphan-server-entry pattern as employee.create, mp_connection.disconnect).
  "andreani.shipment.create": {
    actionType: "andreani.shipment.create",
    routeScope: "agents/andreani/shipment-create",
    resourceType: "AndreaniShipment",
    requiresTrace: true,
    requiresIdempotency: true,
    idempotencyStrategy: "derived",
  },
  // Communications agent Pattern C intents — push fan-out and in-app chat writes.
  // No public route handler; materialized inline by executeCommunicationsActions.
  // Push intents now go through beginIdempotentMutation (DB gate) to prevent
  // duplicate sends on Supervisor retry — same pattern as comm.sms/comm.email.
  // Chat writes deduped by clientMessageId P2002 on the ChatMessage table.
  "comm.owner-push": {
    actionType: "comm.owner-push",
    routeScope: "supervisor.communications",
    resourceType: "PushSubscription",
    requiresTrace: true,
    requiresIdempotency: true,
    idempotencyStrategy: "derived",
  },
  "comm.employee-push": {
    actionType: "comm.employee-push",
    routeScope: "supervisor.communications",
    resourceType: "PushSubscription",
    requiresTrace: true,
    requiresIdempotency: true,
    idempotencyStrategy: "derived",
  },
  "comm.chat-write": {
    actionType: "comm.chat-write",
    routeScope: "supervisor.communications",
    resourceType: "ChatMessage",
    requiresTrace: true,
    requiresIdempotency: true,
    idempotencyStrategy: "derived",
  },
  // comm.sms + comm.email — outbound messaging side-effects materialized by
  // executeCommunicationsActions. No public route handler; idempotency row
  // prevents duplicate sends on supervisor retry (same derived-key strategy
  // as comm.chat-write).
  "comm.sms": {
    actionType: "comm.sms",
    routeScope: "supervisor.communications",
    resourceType: "IdempotencyRecord",
    requiresTrace: true,
    requiresIdempotency: true,
    idempotencyStrategy: "derived",
  },
  "comm.email": {
    actionType: "comm.email",
    routeScope: "supervisor.communications",
    resourceType: "IdempotencyRecord",
    requiresTrace: true,
    requiresIdempotency: true,
    idempotencyStrategy: "derived",
  },
  // assistant.chat — primary chat route (business-assistant/route.ts).
  // Read-heavy but uses idempotency for replay protection and trace for latency
  // observability. No separate route handler — the route IS the handler.
  // requiresIdempotency: true because beginIdempotentMutation is called in the hot path.
  "assistant.chat": {
    actionType: "assistant.chat",
    routeScope: "business-assistant",
    resourceType: "ChatSession",
    requiresTrace: true,
    requiresIdempotency: true,
    idempotencyStrategy: "header",
  },
} as const satisfies Record<string, MutationContractEntry>;
