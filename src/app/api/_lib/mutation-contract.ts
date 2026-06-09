// Re-export the contract entries from a sibling file. Splitting keeps
// this module under the 300-LOC hard limit and lets future entries land
// in mutation-contract-entries.ts without touching consumers.

import type { MutationMethod } from "./mutation-contract-types";
import { SERVER_MUTATION_CONTRACT } from "./mutation-contract-entries";

export { SERVER_MUTATION_CONTRACT };
export { MUTATION_METHODS } from "./mutation-contract-types";
export type { MutationMethod, MutationContractEntry } from "./mutation-contract-types";

export type ServerMutationActionKey = keyof typeof SERVER_MUTATION_CONTRACT;

export type RouteMutationDeclaration = Partial<Record<MutationMethod, ServerMutationActionKey>>;

export function getServerActionMeta<K extends ServerMutationActionKey>(actionKey: K) {
  return SERVER_MUTATION_CONTRACT[actionKey];
}
