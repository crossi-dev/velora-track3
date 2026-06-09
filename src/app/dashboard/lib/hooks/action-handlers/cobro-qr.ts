// Action handler para `confirm_cobro` — módulo Cobro QR.
//
// El servidor ya creó el PaymentIntent en estado pending; este handler abre
// la card visual del cobro en el panel secunjuan del chat. El POST contra
// /api/payment-intents/confirm corre cuando el empleado toca "Marcar cobrado"
// (la lógica del click vive en AssistantCobroQrDraft).
//
// IMPORTANTE: este handler NO confirma el cobro. Solo monta el draft.
//
// Modos:
//   - "qr"    — slice 1: QR placeholder + monto (a futuro: QR dinámico real MP).
//   - "alias" — slice 2: alias MP/CVU del dueño + monto + copy. "Modo informal",
//               cero dependencia de APIs externas, confirmación manual.

import { tLang } from "../../DashboardLangContext";
import type { ActionHandlerArgs } from "./types";
import type { CobroQrDraftMetodo } from "../../types";

const DEFAULT_QR_URL = "/static/qr-placeholder.svg";

export async function handleConfirmCobro({ action, ctx }: ActionHandlerArgs): Promise<boolean> {
  const paymentIntentId = String(action.paymentIntentId ?? "");
  const monto = Number(action.monto ?? 0);
  const qrPlaceholderUrl = String(action.qrPlaceholderUrl ?? DEFAULT_QR_URL);
  const metodoRaw = typeof action.metodo === "string" ? action.metodo : "qr";
  const metodo: CobroQrDraftMetodo = metodoRaw === "alias" ? "alias" : "qr";
  const alias = typeof action.alias === "string" ? action.alias : null;
  // Slice 3 — timeout 2 min. Null si el server no lo mandó (rows legacy o
  // payload viejo); el componente desactiva el countdown en ese caso.
  const expiresAt = typeof action.expiresAt === "string" ? action.expiresAt : null;
  const matchedCustomerId =
    typeof action.matchedCustomerId === "string" ? action.matchedCustomerId : null;
  const customerName =
    typeof action.customerName === "string" ? action.customerName : null;
  const sandbox = action.sandbox === true;

  if (!paymentIntentId || !Number.isFinite(monto) || monto <= 0) {
    const errMsg = ctx.t("Could not resolve the charge.", "No pude resolver el cobro.");
    ctx.setAssistantReply(errMsg);
    ctx.appendChatHistoryEntry("error", errMsg);
    void tLang;
    return true;
  }

  if (metodo === "alias" && !alias) {
    const errMsg = ctx.t(
      "No alias configured for the business.",
      "El negocio no tiene alias configurado.",
    );
    ctx.setAssistantReply(errMsg);
    ctx.appendChatHistoryEntry("error", errMsg);
    return true;
  }

  ctx.setCobroQrDraft({
    metodo,
    paymentIntentId,
    monto,
    qrPlaceholderUrl,
    alias,
    expiresAt,
    matchedCustomerId,
    customerName,
    sandbox,
    status: "pending",
    errorMessage: null,
  });
  return true;
}
