const MP_ERROR_MESSAGES: Record<string, string> = {
  token_exchange_failed:
    "Mercado Pago rechazó la conexión. Revisá tus credenciales en el dashboard de MP developer.",
  invalid_state: "El intento de conexión expiró. Probá de nuevo.",
  missing_code: "Mercado Pago no devolvió el código de autorización. Probá de nuevo.",
  not_configured: "Velora todavía no tiene configuradas las credenciales de Mercado Pago.",
  callback_exception:
    "Hubo un error inesperado conectando con Mercado Pago. Probá de nuevo en unos minutos.",
  rate_limited: "Demasiados intentos. Esperá un minuto y probá de nuevo.",
};

const MP_ERROR_FALLBACK = "Hubo un problema conectando con Mercado Pago.";

export function getMpOAuthErrorMessage(reason: string | null): string {
  if (!reason) return MP_ERROR_FALLBACK;
  return MP_ERROR_MESSAGES[reason] ?? MP_ERROR_FALLBACK;
}
