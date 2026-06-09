const MAX_LEN = 25;

const CONFIRM_RE = /^\s*(si|sí|dale|ok|okey|oka|okay|va|confirmo|confirmar|confirma|confirmado|perfecto|listo|bueno|bien|yes|ya|obvio|obviamente)[.!\s]*$/i;
const CANCEL_RE = /^\s*(no|nope|nah|cancela|cancelar|cancelá|cancelalo|cancelala|olvidalo|olvidate|olvídalo|olvídate|basta|para|pará|mejor no|no gracias|no quiero)[.!\s]*$/i;

export function isShortConfirmation(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > MAX_LEN) return false;
  return CONFIRM_RE.test(trimmed);
}

export function isShortCancellation(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > MAX_LEN) return false;
  return CANCEL_RE.test(trimmed);
}
