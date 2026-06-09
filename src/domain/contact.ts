// Core domain types — no UI, no framework dependencies
// Re-export shim: Customer and Supplier now live in their own files.
// ContactRow is kept here for backwards compat (widely used across the codebase).

export type { Customer } from "./customer";
export type { Supplier } from "./supplier";

/** Shared shape for both Customer and Supplier list rows. */
export interface ContactRow {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  /** Supplier contact person name. */
  contactName?: string | null;
  /** Tax ID (CUIT/DNI/etc.). */
  taxId?: string | null;
  /** IVA condition (Consumidor Final, Monotributista, etc.) — customers only. */
  ivaCondition?: string | null;
  /** Supplier-specific: average lead time in days. */
  leadTimeDays?: number | null;
  /** Customer shipping address fields — null for suppliers. */
  address?: string | null;
  postalCode?: string | null;
  city?: string | null;
}
