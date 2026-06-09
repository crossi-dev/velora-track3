import { z } from "zod";

const CUID = z.string().min(20).max(30).regex(/^[a-z0-9]{20,30}$/, "ID con formato inválido.");

export const createEmployeeBodySchema = z.object({
  name: z.string().min(1).max(60, "El nombre del empleado es requerido (1-60 caracteres)."),
  pin: z.string().regex(/^\d{4,8}$/, "El PIN debe ser numérico de 4 a 8 dígitos."),
}).strict();

export const deleteEmployeeBodySchema = z.object({
  employeeId: CUID,
}).strict();

export type CreateEmployeeBodyInput = z.infer<typeof createEmployeeBodySchema>;
export type DeleteEmployeeBodyInput = z.infer<typeof deleteEmployeeBodySchema>;
