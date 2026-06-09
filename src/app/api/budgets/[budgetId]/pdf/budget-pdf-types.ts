export interface BudgetPdfData {
  businessName: string;
  businessCuit: string | null;
  businessAddress: string | null;
  businessIvaCondition: string | null;
  businessPhone: string | null;
  businessWhatsapp: string | null;
  currency: string;
  budgetNumber: string;
  customerName: string | null;
  customerTaxId: string | null;
  customerEmail: string | null;
  customerPhone: string | null;
  createdAt: Date;
  items: Array<{
    name: string;
    quantity: number;
    unitPrice: number;
    subtotal: number;
  }>;
  /** Shipping cost line. Optional — populated by Customer Agent formal quote flow. */
  shippingCost: number | null;
  /** MercadoPago checkout URL rendered in the "Pagá online" section. Optional. */
  paymentLinkUrl: string | null;
  total: number;
}

export interface BudgetLayout {
  ML: number;
  MR: number;
  PW: number;
  CW: number;
  BLACK: string;
  GRAY: string;
  LIGHTGRAY: string;
  BORDER: string;
  WHITE: string;
  FOOTER_Y: number;
  PAGE_BOTTOM: number;
}

export interface BudgetHeaderContext {
  dateLabel: string;
  validUntilLabel: string;
}
