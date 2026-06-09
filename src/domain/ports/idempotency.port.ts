import type { Tx } from "./tx";

export interface BeginIdempotencyArgs {
  businessId: string;
  actionType: string;
  idempotencyKey: string;
  requestBody: unknown;
}

export type IdempotencyOutcome =
  | { kind: "execute"; recordId: string }
  | { kind: "missing" }
  | { kind: "conflict" }
  | { kind: "replay"; status: number; body: unknown }
  | { kind: "in_flight" };

export interface IdempotencyPort {
  begin(args: BeginIdempotencyArgs): Promise<IdempotencyOutcome>;
  complete(tx: Tx | null, recordId: string, status: number, body: unknown): Promise<void>;
  release(recordId: string | null): Promise<void>;
}
