import { z } from "zod";

const CUID = z.string().min(20).max(30).regex(/^[a-z0-9]{20,30}$/, "ID con formato inválido.");

export const multiPriceUpdateItemSchema = z
  .object({
    productId: CUID,
    price: z.number().nonnegative("Price must be >= 0.").optional(),
    costPrice: z.number().nonnegative("Cost price must be >= 0.").nullable().optional(),
  })
  .strict()
  .refine(
    (data) => data.price !== undefined || data.costPrice !== undefined,
    { message: "Each item must include at least price or costPrice." }
  );

export const multiPriceUpdateBodySchema = z
  .object({
    items: z
      .array(multiPriceUpdateItemSchema)
      .min(1, "At least one item is required.")
      .max(500, "Maximum 500 items per request."),
  })
  .strict();

export type MultiPriceUpdateBodyInput = z.infer<typeof multiPriceUpdateBodySchema>;
