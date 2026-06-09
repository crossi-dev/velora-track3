import { z } from "zod";

export const businessUpdateSchema = z.object({
  name: z.string().max(255).optional(),
  type: z.string().max(100).optional(),
  email: z.string().email().max(255).optional().nullable(),
  // Normalize CUIT to 11 bare digits (strip hyphens) so Business.cuit always
  // matches the format stored in ArcaCredential.cuit (no divergence on lookups).
  cuit: z
    .string()
    .max(30)
    .transform((v) => v.replace(/-/g, ""))
    .pipe(z.string().regex(/^\d{11}$/, "CUIT must be 11 digits").or(z.literal("")))
    .transform((v) => v || null)
    .optional()
    .nullable(),
  address: z.string().max(500).optional().nullable(),
  phone: z.string().max(30).optional().nullable(),
  whatsappPhone: z.string().max(30).optional().nullable(),
  // Cobro QR slice 2: alias personal MP/CVU del dueño (ej. "carlos.mp").
  // Acepta letras, dígitos, guiones, puntos y guion-bajo (formato MP/CVU).
  alias: z.string().max(60).optional().nullable(),
  openingTime: z.string().max(20).optional().nullable(),
  closingTime: z.string().max(20).optional().nullable(),
  currency: z.string().max(10).optional(),
  taxRate: z.preprocess((v) => (v === "" ? undefined : v), z.coerce.number().nonnegative().optional()),
  postalCode: z.string().max(10).optional().nullable(),
  courierPreference: z.enum(["Andreani", "OCA", "ninguno"]).optional().nullable(),
  ivaCondition: z.string().max(50).optional().nullable(),
  puntoVenta: z.string().max(50).optional().nullable(),
  iibb: z.string().max(50).optional().nullable(),
  activityStart: z.string().max(30).optional().nullable(),
  allowNegativeStock: z.boolean().optional(),
  defaultCustomer: z.string().max(30).optional(),
  allowSaleWithoutCustomer: z.boolean().optional(),
  openReceiptAfterSale: z.boolean().optional(),
  autoCreateProductOnStockLoad: z.boolean().optional(),
  suggestWhatsappAfterSale: z.boolean().optional(),
  lowStockThreshold: z.number().int().nonnegative().optional(),
  notifyLowStockWa: z.boolean().optional(),
  // E.164 WhatsApp Business phone number for the lightweight pre-Embedded-Signup
  // capture path. Validated as E.164 (+ prefix + 7-15 digits). Null clears.
  // Source: Stripe incremental currently_due pattern — collect only what's needed now.
  // https://docs.stripe.com/connect/custom/hosted-onboarding
  whatsappBusinessPhoneE164: z
    .string()
    .max(16)
    .regex(/^\+\d{7,15}$/, "Must be a valid E.164 phone number (e.g. +5491100000000)")
    .optional()
    .nullable(),
}).strict();

export type BusinessUpdateInput = z.infer<typeof businessUpdateSchema>;
