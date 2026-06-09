// Core domain types — no UI, no framework dependencies

export type BusinessType =
  | "boutique"
  | "pet_shop"
  | "mini_market"
  | "grocery"
  | "pharmacy"
  | "franchise"
  | "other";

/**
 * Full business entity as returned by the API and used across the dashboard.
 * Consolidates the dashboard-layer Business interface; replaces the previous
 * 6-field minimal version. Fields marked optional are either DB-nullable
 * or stored outside the core Prisma model (e.g. JSON config flags).
 */
export interface Business {
  // Core DB fields
  id: string;
  name: string;
  type: string;
  currency: string;
  taxRate: number;
  createdAt: string;
  workerCount: number;
  openingCash: number;
  // Contact / identification
  cuit?: string | null;
  address?: string | null;
  phone?: string | null;
  email?: string | null;
  whatsappPhone?: string | null;
  // Cobro QR slice 2: alias personal MP/CVU del dueño (ej. "carlos.mp"),
  // declarado en Ajustes. Null hasta que se declare; sin alias el flujo
  // "cobro alias" responde con un error chip pidiendo configurarlo primero.
  alias?: string | null;
  // Operating hours
  openingTime?: string | null;
  closingTime?: string | null;
  // Argentine fiscal fields
  ivaCondition?: string | null;
  puntoVenta?: string | null;
  iibb?: string | null;
  activityStart?: string | null;
  // Behavioural config flags
  allowNegativeStock?: boolean;
  // Per-owner opt-in: WA alert when stock drops below threshold. Default OFF.
  notifyLowStockWa?: boolean;
  // Onboarding / engagement flags. firstSaleConfirmed flips to true the moment the
  // owner closes their first chat-driven sale; the dashboard hook reads it to gate
  // the Web Push browser permission prompt (primer chat message + OS dialog land
  // together, never on cold mount).
  firstSaleConfirmed?: boolean;
  defaultCustomer?: string;
  allowSaleWithoutCustomer?: boolean;
  openReceiptAfterSale?: boolean;
  autoCreateProductOnStockLoad?: boolean;
  suggestWhatsappAfterSale?: boolean;
  lowStockThreshold?: number;
  sessionDurationHours?: number | null;
  // Shipping / fiscal — columns added 2026-05-17 (already in DB schema).
  postalCode?: string | null;
  courierPreference?: string | null;
  // Aspirational domain fields (not yet in DB schema)
  businessType?: BusinessType;
  timezone?: string;
  locale?: string;
}
