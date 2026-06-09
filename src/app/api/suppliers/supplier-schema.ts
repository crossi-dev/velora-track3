import { z } from "zod";

const CUID = z.string().min(1).max(30).regex(/^[a-z0-9]{20,30}$/, "ID con formato inválido.");

export const supplierCreateSchema = z.object({
  name: z.string().max(255).optional().nullable(),
  phone: z.string().max(30).optional().nullable(),
  email: z.string().email().max(255).optional().nullable(),
  taxId: z.string().max(30).optional().nullable(),
  contactName: z.string().max(255).optional().nullable(),
  leadTimeDays: z.number().int().nonnegative().max(365).optional().nullable(),
}).strict();

export const supplierUpdateSchema = supplierCreateSchema.extend({
  id: CUID.optional(),
});

export const supplierDeleteSchema = z.object({ id: CUID }).strict();

export type SupplierCreateInput = z.infer<typeof supplierCreateSchema>;
export type SupplierUpdateInput = z.infer<typeof supplierUpdateSchema>;
export type SupplierDeleteInput = z.infer<typeof supplierDeleteSchema>;
