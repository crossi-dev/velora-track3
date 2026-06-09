export const MUTATION_METHODS = ["POST", "PATCH", "PUT", "DELETE"] as const;
export type MutationMethod = (typeof MUTATION_METHODS)[number];

export interface MutationContractEntry {
  actionType: string;
  routeScope: string;
  resourceType: string;
  requiresTrace: boolean;
  requiresIdempotency: boolean;
  idempotencyStrategy: "header" | "derived";
  compositeChildren?: readonly string[];
}
