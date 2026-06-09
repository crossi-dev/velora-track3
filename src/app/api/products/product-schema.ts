import { z } from "zod";

const CUID = z.string().min(20).max(30).regex(/^[a-z0-9]{20,30}$/, "ID con formato inválido.");

export const createProductBodySchema = z.object({
  name: z.string().min(1, "El nombre es obligatorio.").max(255),
  price: z.number().nonnegative(),
  costPrice: z.number().nonnegative().optional(),
  stock: z.number().int().nonnegative().optional(),
  stockReason: z.string().max(500).optional(),
  stockReferenceId: z.string().max(100).optional(),
  weightGrams: z.number().int().positive().max(500_000).optional(),
}).strict();

export const updateProductBodySchema = z.object({
  id: CUID,
  name: z.string().min(1, "El nombre es obligatorio.").max(255).optional(),
  price: z.number().nonnegative().optional(),
  costPrice: z.number().nonnegative().nullable().optional(),
  stock: z.number().int().nonnegative().optional(),
  sku: z.string().max(100).nullable().optional(),
  stockReason: z.string().max(500).optional(),
  stockReferenceId: z.string().max(100).optional(),
  weightGrams: z.number().int().positive().max(500_000).nullable().optional(),
}).strict();

export const deleteProductBodySchema = z.object({
  id: CUID,
}).strict();

export type CreateProductBodyInput = z.infer<typeof createProductBodySchema>;
export type UpdateProductBodyInput = z.infer<typeof updateProductBodySchema>;
export type DeleteProductBodyInput = z.infer<typeof deleteProductBodySchema>;
