// sale_create_inline_new_customer intent — extracted from types.ts to keep
// that file within the 300-line server/api contract.
//
// Emitted when the fast-path detector resolves the product AND the text
// contains "a/para [Nombre] [teléfono]" that doesn't match any existing
// catalog customer. The dispatcher shows a confirmation card that creates
// the customer inline (upsert by phone) before registering the sale.
//
// Idempotency: the mutation uses upsert-by-phone so retrying the same
// clientMessageId never creates a duplicate customer record.

export interface SaleCreateInlineNewCustomerIntent {
  kind: "sale_create_inline_new_customer";
  matchedProductId: string;
  productName: string;
  qty: number;
  unitPrice: number | null;
  /** Display name parsed from the raw text. Title-cased as typed by the owner. */
  newCustomerName: string;
  /** Normalized E.164 Argentine mobile: +549XXXXXXXXXX. */
  newCustomerPhone: string;
}
