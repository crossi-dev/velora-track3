import { z } from "zod";

const CUID = z.string().min(20).max(30).regex(/^[a-z0-9]{20,30}$/, "ID con formato inválido.");

export const budgetItemSchema = z.object({
  productId: CUID.optional(),
  name: z.string().min(1, "El nombre del ítem es obligatorio.").max(255),
  quantity: z
    .number()
    .int("La cantidad debe ser un entero.")
    .positive("La cantidad debe ser mayor a 0."),
  unitPrice: z.number().nonnegative("El precio unitario no puede ser negativo."),
}).strict();

export const createBudgetBodySchema = z.object({
  customerName: z.string().max(255).optional(),
  customerId: CUID.optional(),
  note: z.string().max(500).optional(),
  items: z.array(budgetItemSchema).min(1, "Hace falta al menos un ítem."),
}).strict();

export const deleteBudgetBodySchema = z.object({
  budgetId: CUID,
}).strict();

export type CreateBudgetBodyInput = z.infer<typeof createBudgetBodySchema>;
export type DeleteBudgetBodyInput = z.infer<typeof deleteBudgetBodySchema>;
