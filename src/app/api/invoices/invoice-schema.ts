import { z } from "zod";

const VALID_STATUSES = ["issued", "sent", "paid"] as const;

export const updateInvoiceStatusBodySchema = z.object({
  status: z.enum(VALID_STATUSES, {
    errorMap: () => ({ message: "El estado de la factura es inválido." }),
  }),
}).strict();

export type UpdateInvoiceStatusBodyInput = z.infer<typeof updateInvoiceStatusBodySchema>;
