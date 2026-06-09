import { z } from "zod";

const CUID = z.string().min(20).max(30).regex(/^[a-z0-9]{20,30}$/, "ID con formato inválido.");

export const purchaseRequestCreateSchema = z.object({
  // businessId is NOT accepted from the client — derived from authenticated actor.
  supplierId: CUID.optional().nullable(),
  supplierName: z.string().max(255).optional().nullable(),
  itemName: z.string().max(255).optional(),
  quantity: z.coerce.number().positive().optional(),
  unitPrice: z.preprocess((v) => (v === "" ? undefined : v), z.coerce.number().nonnegative().optional()),
}).strict();

export type PurchaseRequestCreateInput = z.infer<typeof purchaseRequestCreateSchema>;
