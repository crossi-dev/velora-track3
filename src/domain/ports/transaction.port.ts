import type { Tx } from "./tx";

export interface TransactionPort {
  run<T>(work: (tx: Tx) => Promise<T>): Promise<T>;
}
