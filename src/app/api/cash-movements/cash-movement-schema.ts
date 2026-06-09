import { z } from "zod";

const VALID_MOVEMENT_TYPES = [
  "purchase",
  "tax",
  "salary",
  "adjustment",
  "income",
  // "withdrawal" = sangría / retiro de efectivo de caja.
  // Distinct from "adjustment" so reports can categorize it correctly.
  // Added 2026-06-03 (caja tools pilot).
  "withdrawal",
] as const;

export const createCashMovementBodySchema = z.object({
  type: z.enum(VALID_MOVEMENT_TYPES, {
    errorMap: () => ({ message: "Tipo de movimiento inválido." }),
  }),
  description: z.string().trim().min(1, "La descripción es obligatoria.").max(500),
  amount: z
    .number()
    .finite("El monto debe ser un número finito.")
    .min(-999_999_999, "El monto no puede ser menor a -999.999.999.")
    .max(999_999_999, "El monto no puede superar 999.999.999.")
    .refine((v) => v !== 0, { message: "El monto debe ser distinto de 0." }),
  date: z.string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "La fecha debe tener formato YYYY-MM-DD.")
    .refine((v) => !Number.isNaN(Date.parse(v)), "La fecha no es un día válido.")
    .optional(),
}).strict();

export type CreateCashMovementBodyInput = z.infer<typeof createCashMovementBodySchema>;
