"use client";

// Barrel module — preserves the stable public API of pendingSaleFlow.
// Implementation is split across:
//   - pendingSaleFlow.types        → shared type definitions
//   - pendingSaleFlow.helpers      → number parsing, token + name matching, quantity/price extraction
//   - pendingSaleFlow.intent       → intent detection (new-sale vs reply, cancel, clarification)
//   - pendingSaleFlow.transitions  → recovery + per-stage transitions + reminder/context/hint builders

export type {
  PendingSaleMissingField,
  PendingSaleFlow,
} from "./pendingSaleFlow.types";

export {
  extractQuantityFromSaleReply,
  extractPriceFromSaleReply,
} from "./pendingSaleFlow.helpers";

export {
  inferPendingSaleFlow,
  looksLikeNewSaleIntent,
  isSaleFlowCancelCommand,
} from "./pendingSaleFlow.intent";

export {
  buildPendingSaleQuestionContext,
  defaultPendingSaleInputHint,
  buildPendingSaleReminder,
  recoverPendingSaleFlow,
  resolvePendingCustomerReply,
} from "./pendingSaleFlow.transitions";
