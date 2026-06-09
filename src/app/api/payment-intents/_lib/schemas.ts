import { z } from "zod";

// Slice 1: "qr_dynamic_fake" (placeholder QR estático).
// Slice 2: "alias_personal" (modo informal — alias MP/CVU del dueño).
// Camino corto MP: "qr_dynamic_real" (QR real generado vía MP API).
// Link de pago MP: "checkout_pro_link" (Checkout Pro — creado por Payments Agent).
export const createPaymentIntentBodySchema = z.object({
  saleId: z.string().min(1).max(64).nullable().optional(),
  monto: z
    .number({ invalid_type_error: "monto debe ser numérico" })
    .positive({ message: "monto debe ser > 0" })
    .max(99_999_999.99, "monto excede el límite"),
  metodo: z.enum(["qr_dynamic_fake", "qr_dynamic_real", "alias_personal", "checkout_pro_link"]),
});

export const confirmPaymentIntentBodySchema = z.object({
  paymentIntentId: z.string().min(1).max(64),
});

// Slice 5 — Devolución cash V1. Mismo body shape que confirm (paymentIntentId
// + idempotencyKey por header). El use-case rechaza si estado !== "confirmed".
export const refundPaymentIntentBodySchema = z.object({
  paymentIntentId: z.string().min(1).max(64),
});

// Cancel — empleado descarta un cobro pendiente antes de que el cliente pague.
// Solo permite pending → cancelled. El use-case rechaza cualquier otro estado.
export const cancelPaymentIntentBodySchema = z.object({
  paymentIntentId: z.string().min(1).max(64),
});
