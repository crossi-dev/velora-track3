"use client";

// Barrel module: re-exports named utilities from focused submodules.
// Consumers import from "./utils" (or "@/app/dashboard/lib/hooks/utils")
// and remain decoupled from the internal file layout.

export { resolveBrowserLocale } from "@/lib/site-locale";

export {
  clearMutationKey,
  clearMutationKeysForAction,
  getOrCreateMutationKey,
  buildMutationHeaders,
  stableSerialize,
  createMutationSignature,
} from "./utils.mutation";

export {
  normalizePersonOrBusinessName,
  buildCustomerFullName,
  splitCustomerName,
  cleanDisplayInput,
} from "./utils.names";

export { fetchWithTimeout, getSafeJson, buildPollingBackoff } from "./utils.fetch";
export type { PollingBackoffState } from "./utils.fetch";

export { isClearChatCommand, getParsedSaleCommand } from "./utils.commands";

export {
  looksLikeParsedSaleCorrection,
  mergeParsedSaleCorrection,
  buildEditableSaleText,
} from "./utils.corrections";

export {
  looksLikeFreshTopLevelTask,
  shouldContinueAssistantQuestionTurn,
} from "./utils.assistant";
