/* eslint-disable max-lines -- single coherent contract object; splitting would break check-action-contract.mjs (see CLAUDE.md) */
"use client";

export const ACTION_LAYERS = [
  "IntakeAdapter",
  "ActionNode",
  "AuthoritativeExecution",
  "PostActionPipeline",
] as const;

export type ActionLayer = (typeof ACTION_LAYERS)[number];

export const OWNERSHIP_CATEGORIES = [
  "draft",
  "confirmation",
  "commit",
  "trace",
  "refresh",
  "cancel",
  "supersede",
  "undo",
  "retry",
  "rehydration",
] as const;

export type OwnershipCategory = (typeof OWNERSHIP_CATEGORIES)[number];

export type ActionType = "mutation" | "query" | "orchestration" | "navigation";

export interface ActionMetadata {
  requiresDraft: boolean;
  requiresConfirmation: boolean;
  requiresTrace: boolean;
  requiresRefresh: boolean;
  supportsUndo: boolean;
  actionType: ActionType;
}

export const CANONICAL_ACTION_KEYS = [
  "sale.draft.open",
  "sale.draft.update",
  "sale.draft.cancel",
  "sale.create",
  "sale.confirm",
  "sale.confirm-and-send-whatsapp",
  "stock-load.create",
  "stock.adjust",
  "product.create",
  "product.update",
  "product.delete",
  "product.resolve-or-create",
  "customer.create",
  "customer.update",
  "customer.delete",
  "supplier.create",
  "supplier.update",
  "supplier.delete",
  "invoice.update-status",
  "invoice.send-whatsapp",
  "invoice.download-pdf",
  "cash-movement.create",
  "business.update",
  "purchase-request.create",
  "purchase-request.send-whatsapp",
  "purchase-request.download-pdf",
  "import.create",
  "product.bulk-price-update",
  "product.multi-price-update",
  "undo.execute",
  "budget.create",
  "budget.delete",
  "budget.send-whatsapp",
  "chat-trace.hydrate",
  "dashboard.refresh",
  "navigation.open-tab",
  "push-notifications.subscribe",
  "payment_intent.create",
  "payment_intent.confirm",
  "payment_intent.refund",
  "payment_intent.cancel",
] as const;

export type CanonicalActionKey = (typeof CANONICAL_ACTION_KEYS)[number];

export const CANONICAL_RUNTIME_ACTION_KEYS = [
  "sale.create",
  "stock.adjust",
  "stock-load.create",
  "cash-movement.create",
  "product.create",
  "product.update",
  "product.delete",
  "product.resolve-or-create",
  "customer.create",
  "customer.update",
  "customer.delete",
  "supplier.create",
  "supplier.update",
  "supplier.delete",
  "invoice.update-status",
  "invoice.send-whatsapp",
  "business.update",
  "undo.execute",
  "purchase-request.create",
  "purchase-request.send-whatsapp",
  "product.bulk-price-update",
  "product.multi-price-update",
  "budget.create",
  "budget.delete",
  "budget.send-whatsapp",
  "push-notifications.subscribe",
] as const satisfies readonly CanonicalActionKey[];

export type CanonicalRuntimeActionKey = (typeof CANONICAL_RUNTIME_ACTION_KEYS)[number];

export const ACTION_METADATA: Record<CanonicalActionKey, ActionMetadata> = {
  "sale.draft.open": {
    requiresDraft: true,
    requiresConfirmation: false,
    requiresTrace: false,
    requiresRefresh: false,
    supportsUndo: false,
    actionType: "orchestration",
  },
  "sale.draft.update": {
    requiresDraft: true,
    requiresConfirmation: false,
    requiresTrace: false,
    requiresRefresh: false,
    supportsUndo: false,
    actionType: "orchestration",
  },
  "sale.draft.cancel": {
    requiresDraft: true,
    requiresConfirmation: false,
    requiresTrace: true,
    requiresRefresh: false,
    supportsUndo: false,
    actionType: "orchestration",
  },
  "sale.create": {
    requiresDraft: true,
    requiresConfirmation: true,
    requiresTrace: true,
    requiresRefresh: true,
    supportsUndo: true,
    actionType: "mutation",
  },
  "sale.confirm": {
    requiresDraft: true,
    requiresConfirmation: true,
    requiresTrace: true,
    requiresRefresh: true,
    supportsUndo: true,
    actionType: "orchestration",
  },
  "sale.confirm-and-send-whatsapp": {
    requiresDraft: true,
    requiresConfirmation: true,
    requiresTrace: true,
    requiresRefresh: true,
    supportsUndo: true,
    actionType: "orchestration",
  },
  "stock-load.create": {
    requiresDraft: false,
    requiresConfirmation: false,
    requiresTrace: true,
    requiresRefresh: true,
    supportsUndo: true,
    actionType: "mutation",
  },
  "stock.adjust": {
    requiresDraft: false,
    requiresConfirmation: true,
    requiresTrace: true,
    requiresRefresh: true,
    supportsUndo: false,
    actionType: "mutation",
  },
  "product.create": {
    requiresDraft: false,
    requiresConfirmation: false,
    requiresTrace: true,
    requiresRefresh: true,
    supportsUndo: false,
    actionType: "mutation",
  },
  "product.update": {
    requiresDraft: false,
    requiresConfirmation: false,
    requiresTrace: true,
    requiresRefresh: true,
    supportsUndo: false,
    actionType: "mutation",
  },
  "product.delete": {
    requiresDraft: false,
    requiresConfirmation: true,
    requiresTrace: true,
    requiresRefresh: true,
    supportsUndo: false,
    actionType: "mutation",
  },
  "product.resolve-or-create": {
    requiresDraft: false,
    requiresConfirmation: false,
    requiresTrace: true,
    requiresRefresh: true,
    supportsUndo: false,
    actionType: "mutation",
  },
  "customer.create": {
    requiresDraft: false,
    requiresConfirmation: false,
    requiresTrace: true,
    requiresRefresh: true,
    supportsUndo: false,
    actionType: "mutation",
  },
  "customer.update": {
    requiresDraft: false,
    requiresConfirmation: false,
    requiresTrace: true,
    requiresRefresh: true,
    supportsUndo: false,
    actionType: "mutation",
  },
  "customer.delete": {
    requiresDraft: false,
    requiresConfirmation: true,
    requiresTrace: true,
    requiresRefresh: true,
    supportsUndo: true,
    actionType: "mutation",
  },
  "supplier.create": {
    requiresDraft: false,
    requiresConfirmation: false,
    requiresTrace: true,
    requiresRefresh: true,
    supportsUndo: false,
    actionType: "mutation",
  },
  "supplier.update": {
    requiresDraft: false,
    requiresConfirmation: false,
    requiresTrace: true,
    requiresRefresh: true,
    supportsUndo: false,
    actionType: "mutation",
  },
  "supplier.delete": {
    requiresDraft: false,
    requiresConfirmation: true,
    requiresTrace: true,
    requiresRefresh: true,
    supportsUndo: false,
    actionType: "mutation",
  },
  "invoice.update-status": {
    requiresDraft: false,
    requiresConfirmation: false,
    requiresTrace: true,
    requiresRefresh: true,
    supportsUndo: false,
    actionType: "mutation",
  },
  "invoice.send-whatsapp": {
    requiresDraft: false,
    requiresConfirmation: false,
    requiresTrace: true,
    requiresRefresh: true,
    supportsUndo: false,
    actionType: "mutation",
  },
  "invoice.download-pdf": {
    requiresDraft: false,
    requiresConfirmation: false,
    requiresTrace: false,
    requiresRefresh: false,
    supportsUndo: false,
    actionType: "query",
  },
  "cash-movement.create": {
    requiresDraft: false,
    requiresConfirmation: false,
    requiresTrace: true,
    requiresRefresh: true,
    supportsUndo: false,
    actionType: "mutation",
  },
  "business.update": {
    requiresDraft: false,
    requiresConfirmation: false,
    requiresTrace: true,
    requiresRefresh: true,
    supportsUndo: false,
    actionType: "mutation",
  },
  "purchase-request.create": {
    requiresDraft: false,
    requiresConfirmation: true,
    requiresTrace: true,
    requiresRefresh: true,
    supportsUndo: false,
    actionType: "mutation",
  },
  "purchase-request.send-whatsapp": {
    requiresDraft: false,
    requiresConfirmation: false,
    requiresTrace: true,
    requiresRefresh: false,
    supportsUndo: false,
    actionType: "mutation",
  },
  "purchase-request.download-pdf": {
    requiresDraft: false,
    requiresConfirmation: false,
    requiresTrace: false,
    requiresRefresh: false,
    supportsUndo: false,
    actionType: "query",
  },
  "import.create": {
    requiresDraft: false,
    requiresConfirmation: false,
    requiresTrace: true,
    requiresRefresh: true,
    supportsUndo: false,
    actionType: "mutation",
  },
  "product.bulk-price-update": {
    requiresDraft: false,
    requiresConfirmation: true,
    requiresTrace: true,
    requiresRefresh: true,
    supportsUndo: false,
    actionType: "mutation",
  },
  "product.multi-price-update": {
    requiresDraft: false,
    requiresConfirmation: true,
    requiresTrace: true,
    requiresRefresh: true,
    supportsUndo: false,
    actionType: "mutation",
  },
  "undo.execute": {
    requiresDraft: false,
    requiresConfirmation: true,
    requiresTrace: true,
    requiresRefresh: true,
    supportsUndo: false,
    actionType: "mutation",
  },
  "budget.create": {
    requiresDraft: false,
    requiresConfirmation: false,
    requiresTrace: true,
    requiresRefresh: true,
    supportsUndo: false,
    actionType: "mutation",
  },
  "budget.delete": {
    requiresDraft: false,
    requiresConfirmation: true,
    requiresTrace: true,
    requiresRefresh: true,
    supportsUndo: false,
    actionType: "mutation",
  },
  "budget.send-whatsapp": {
    requiresDraft: false,
    requiresConfirmation: false,
    requiresTrace: true,
    requiresRefresh: false,
    supportsUndo: false,
    actionType: "mutation",
  },
  "chat-trace.hydrate": {
    requiresDraft: false,
    requiresConfirmation: false,
    requiresTrace: false,
    requiresRefresh: false,
    supportsUndo: false,
    actionType: "query",
  },
  "dashboard.refresh": {
    requiresDraft: false,
    requiresConfirmation: false,
    requiresTrace: false,
    requiresRefresh: false,
    supportsUndo: false,
    actionType: "orchestration",
  },
  "navigation.open-tab": {
    requiresDraft: false,
    requiresConfirmation: false,
    requiresTrace: false,
    requiresRefresh: false,
    supportsUndo: false,
    actionType: "navigation",
  },
  "push-notifications.subscribe": {
    requiresDraft: false,
    requiresConfirmation: false,
    requiresTrace: true,
    requiresRefresh: false,
    supportsUndo: false,
    actionType: "mutation",
  },
  "payment_intent.create": {
    requiresDraft: false,
    requiresConfirmation: false,
    requiresTrace: true,
    requiresRefresh: false,
    supportsUndo: false,
    actionType: "mutation",
  },
  "payment_intent.confirm": {
    requiresDraft: false,
    requiresConfirmation: false,
    requiresTrace: true,
    requiresRefresh: true,
    supportsUndo: false,
    actionType: "mutation",
  },
  "payment_intent.refund": {
    requiresDraft: false,
    requiresConfirmation: false,
    requiresTrace: true,
    requiresRefresh: true,
    supportsUndo: false,
    actionType: "mutation",
  },
  "payment_intent.cancel": {
    requiresDraft: false,
    requiresConfirmation: false,
    requiresTrace: true,
    requiresRefresh: false,
    supportsUndo: false,
    actionType: "mutation",
  },
};

export const SALE_CANONICAL_ACTION_NODE_KEYS = [
  "sale.draft.open",
  "sale.draft.update",
  "sale.draft.cancel",
  "sale.confirm",
  "sale.confirm-and-send-whatsapp",
] as const satisfies readonly CanonicalActionKey[];

export const SALE_ACTION_NODE_OWNERSHIP = {
  "sale.draft.open": "ActionNode",
  "sale.draft.update": "ActionNode",
  "sale.draft.cancel": "ActionNode",
  "sale.confirm": "ActionNode",
  "sale.confirm-and-send-whatsapp": "ActionNode",
  "sale.create": "AuthoritativeExecution",
} as const;

export interface OwnershipRule {
  owner: ActionLayer;
  rationale: string;
}

export const OWNERSHIP_CONTRACT: Record<OwnershipCategory, OwnershipRule> = {
  draft: {
    owner: "ActionNode",
    rationale: "El borrador vive en un nodo compartido por accion, no en cada intake.",
  },
  confirmation: {
    owner: "ActionNode",
    rationale: "La confirmacion es unica por accion y no debe duplicarse por superficie.",
  },
  commit: {
    owner: "AuthoritativeExecution",
    rationale: "Toda mutacion durable sale por un unico commit autoritativo.",
  },
  trace: {
    owner: "AuthoritativeExecution",
    rationale: "La traza durable se emite junto al commit autoritativo.",
  },
  refresh: {
    owner: "PostActionPipeline",
    rationale: "Refresh y sincronizacion post-accion son unificados.",
  },
  cancel: {
    owner: "ActionNode",
    rationale: "Cancelar se resuelve en el mismo nodo compartido del flujo.",
  },
  supersede: {
    owner: "ActionNode",
    rationale: "La accion vigente reemplaza a la anterior en un solo punto.",
  },
  undo: {
    owner: "AuthoritativeExecution",
    rationale: "Deshacer modifica estado durable y no puede depender del intake.",
  },
  retry: {
    owner: "PostActionPipeline",
    rationale: "Retry conserva reglas idempotentes y cierre consistente.",
  },
  rehydration: {
    owner: "PostActionPipeline",
    rationale: "La UI se rehidrata desde fuente durable y reglas unicas.",
  },
};

export interface ForbiddenPattern {
  code: string;
  description: string;
}

export const FORBIDDEN_PATTERNS: readonly ForbiddenPattern[] = [
  {
    code: "direct-mutation-from-intake",
    description: "Ningun IntakeAdapter puede ejecutar mutaciones de negocio directas.",
  },
  {
    code: "multiple-confirmation-nodes",
    description: "Una accion no puede tener mas de un nodo de confirmacion.",
  },
  {
    code: "multiple-commit-functions",
    description: "Una accion no puede tener mas de una funcion de commit.",
  },
  {
    code: "split-trace-ownership",
    description: "La traza no puede dividir ownership entre cliente y servidor.",
  },
  {
    code: "local-business-history-bypass",
    description: "Los resultados de negocio no se escriben en chat local; solo en traza durable rehidratada.",
  },
  {
    code: "non-transient-local-reply",
    description: "Los replies locales solo pueden existir si se marcan explícitamente como transitorios.",
  },
  {
    code: "per-intake-refresh-logic",
    description: "Refresh/rehydration no pueden variar por intake surface.",
  },
  {
    code: "hidden-composite-mutations",
    description: "Acciones compuestas deben declarar explicitamente sus mutaciones hijas.",
  },
  {
    code: "stock-load-delegation-to-standalone-create",
    description: "stock-load.create no puede delegar a acciones create standalone; los subpasos son internos.",
  },
  {
    code: "invoice-whatsapp-post-action-bypass",
    description: "invoice.send-whatsapp debe resolver exito y refresh desde un handler canonico compartido.",
  },
  {
    code: "legacy-bypass-after-migration",
    description: "No pueden quedar bypasses legacy activos despues de migrar una accion.",
  },
] as const;

export const COMPOSITE_ACTIONS = {
  "sale.confirm": ["sale.create", "dashboard.refresh", "chat-trace.hydrate"],
  "sale.confirm-and-send-whatsapp": [
    "sale.create",
    "invoice.send-whatsapp",
    "dashboard.refresh",
    "chat-trace.hydrate",
  ],
  "invoice.send-whatsapp": ["dashboard.refresh", "chat-trace.hydrate"],
  "stock-load.create": ["dashboard.refresh", "chat-trace.hydrate"],
} as const satisfies Partial<Record<CanonicalActionKey, readonly CanonicalActionKey[]>>;
