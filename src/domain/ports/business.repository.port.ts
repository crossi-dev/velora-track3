import type { Tx } from "./tx";

export interface BusinessForUpdate {
  id: string;
  name: string;
  type: string;
  email: string | null;
  cuit: string | null;
  address: string | null;
  phone: string | null;
  whatsappPhone: string | null;
  // Cobro QR slice 2: alias personal MP/CVU del dueño (ej. "carlos.mp").
  // Null hasta que el dueño lo declare en Ajustes; sin alias el flujo
  // "modo informal" pide configurarlo antes de cobrar.
  alias: string | null;
  // E.164 WhatsApp Business phone number — lower-tier capability signal
  // pre-Meta Embedded Signup. Set via connect_whatsapp_business tool or
  // the Services tab manual capture form. Null until set.
  whatsappBusinessPhoneE164: string | null;
  openingTime: string | null;
  closingTime: string | null;
  currency: string;
  taxRate: number;
  ivaCondition: string | null;
  puntoVenta: string | null;
  iibb: string | null;
  activityStart: string | null;
  allowNegativeStock: boolean;
  defaultCustomer: string;
  allowSaleWithoutCustomer: boolean;
  openReceiptAfterSale: boolean;
  autoCreateProductOnStockLoad: boolean;
  suggestWhatsappAfterSale: boolean;
  lowStockThreshold: number;
  postalCode: string | null;
  courierPreference: string | null;
  notifyLowStockWa: boolean;
}

export type BusinessUpdateData = Omit<BusinessForUpdate, "id">;

export interface BusinessRepositoryPort {
  findById(id: string): Promise<{ id: string; allowNegativeStock: boolean } | null>;
  findCurrency(id: string): Promise<{ currency: string } | null>;
  findByUserId(userId: string): Promise<{ id: string } | null>;
  findForUpdate(businessId: string): Promise<BusinessForUpdate | null>;
  updateInTransaction(tx: Tx, businessId: string, data: BusinessUpdateData): Promise<BusinessForUpdate>;
}
