import { z } from "zod";
import { CUSTOMER_IVA_CONDITIONS } from "@/app/api/business-assistant/_lib/onboarding-fast-path.fiscal-setup";
import { normalizePhone } from "@/lib/whatsapp-meta";

const CUID = z.string().min(20).max(30).regex(/^[a-z0-9]{20,30}$/, "ID con formato inválido.");
const nullableString = z.string().max(255).nullable().optional();
const nullableEmail = z.string().email().max(255).nullable().optional();
const ivaConditionField = z.enum(CUSTOMER_IVA_CONDITIONS).nullable().optional();
// DNI argentino: 7-8 dígitos sin puntos. Required for Andreani shipments.
const nullableDni = z.string().regex(/^\d{7,8}$/, "DNI debe tener 7 u 8 dígitos.").nullable().optional();

// Phone is normalized to E.164 at storage time so every consumer sees the same
// canonical shape (`+549<area><number>` for AR mobiles). Accepts any human
// input (spaces, hyphens, parens, leading 0, missing +). Empty/null pass through.
const normalizedPhone = z
  .union([z.string().max(255), z.null()])
  .optional()
  .transform((v) => {
    if (v === null || v === undefined) return v;
    const trimmed = v.trim();
    if (!trimmed) return null;
    try {
      return normalizePhone(trimmed);
    } catch {
      // Invalid phone — surface as a zod validation error in the next step.
      return trimmed;
    }
  })
  .pipe(
    z.union([
      z.string().regex(/^\+\d{8,16}$/, "Teléfono no es un E.164 válido."),
      z.null(),
    ]).optional(),
  );

export const createCustomerBodySchema = z.object({
  name: z.string().min(1).max(255).optional(),
  phone: normalizedPhone,
  email: nullableEmail,
  taxId: z.string().max(30).nullable().optional(),
  dni: nullableDni,
  ivaCondition: ivaConditionField,
  address: nullableString,
  postalCode: z.string().max(20).nullable().optional(),
  city: nullableString,
}).strict();

export const updateCustomerBodySchema = z.object({
  id: CUID,
  name: z.string().max(255).nullable().optional(),
  phone: normalizedPhone,
  email: nullableEmail,
  taxId: z.string().max(30).nullable().optional(),
  dni: nullableDni,
  ivaCondition: ivaConditionField,
  address: nullableString,
  postalCode: z.string().max(20).nullable().optional(),
  city: nullableString,
}).strict();

export const deleteCustomerBodySchema = z.object({
  id: CUID,
}).strict();

export type CreateCustomerBodyInput = z.infer<typeof createCustomerBodySchema>;
export type UpdateCustomerBodyInput = z.infer<typeof updateCustomerBodySchema>;
export type DeleteCustomerBodyInput = z.infer<typeof deleteCustomerBodySchema>;
