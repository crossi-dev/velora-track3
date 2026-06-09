import { z } from "zod";
import { PAYMENT_METHOD_VALUES } from "@/domain/sale";

// Re-export so existing importers of sale-schema keep working.
export { PAYMENT_METHOD_VALUES } from "@/domain/sale";
export type { PaymentMethodValue } from "@/domain/sale";

const CUID = z.string().min(20).max(30).regex(/^[a-z0-9]{20,30}$/, "ID con formato inválido.");

export const saleItemSchema = z.object({
  productId: CUID,
  quantity: z.number().int().positive(),
  unitPrice: z.number().positive(),
}).strict();

export const createSaleBodySchema = z
  .object({
    // businessId is NOT accepted from the client — derived from authenticated actor.
    items: z.array(saleItemSchema).min(1),
    total: z.number().positive(),
    customerId: CUID.optional(),
    locale: z.string().max(20).optional(),
    defaultCustomerName: z.string().max(100).optional(),
    // Optional — defaults to "efectivo" when absent so existing clients keep working.
    paymentMethod: z.enum(PAYMENT_METHOD_VALUES).optional(),
    // When true, the server skips sendInvoiceAutoWhatsApp because the client
    // is handling the WhatsApp send itself (Path A). Prevents duplicate sends.
    skipAutoWhatsapp: z.boolean().optional(),
  })
  .strict();

export type CreateSaleBodyInput = z.infer<typeof createSaleBodySchema>;
