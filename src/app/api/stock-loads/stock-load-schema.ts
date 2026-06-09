import { z } from "zod";

const CUID = z.string().min(20).max(30).regex(/^[a-z0-9]{20,30}$/, "ID con formato inválido.");

export const stockLoadSchema = z
  .object({
    productId: CUID.optional(),
    itemName: z.string().max(255).optional(),
    supplierId: CUID.optional(),
    supplierName: z.string().max(255).optional(),
    quantity: z.coerce.number().positive("La cantidad debe ser mayor a 0."),
    unitPrice: z.preprocess((v) => (v === "" ? undefined : v), z.coerce.number().nonnegative().nullable().optional()),
    note: z.string().max(500).optional(),
    createPurchaseRequest: z.boolean().optional(),
    autoCreateProduct: z.boolean().optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (!data.productId && !data.itemName) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["productId"],
        message: "Se requiere productId o itemName para identificar el producto.",
      });
    }
  });

export type StockLoadSchemaInput = z.infer<typeof stockLoadSchema>;
