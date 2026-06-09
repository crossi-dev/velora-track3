// Error classification for the assistant chat fetch path.
//
// Three classes drive three different UX treatments:
//   network → offer retry, queue offline if disconnected
//   server  → suggest user wait a few seconds before retrying
//   client  → don't offer retry (4xx is typically user input related)
//
// `fetchWithTimeout` surfaces specific strings for AbortError (timeout),
// HTML-content error pages, and session expiry. We also match generic
// TypeError ("Failed to fetch") emitted by the browser when offline, and
// Spanish equivalents from the i18n layer.

export function isNetworkError(msg: string | undefined | null): boolean {
  if (!msg) return false;
  const m = msg.toLowerCase();
  return (
    m.includes("sin respuesta del servidor") ||
    m.includes("error de conexión") ||
    m.includes("sin conexión") ||
    m.includes("failed to fetch") ||
    m.includes("network") ||
    m.includes("networkerror") ||
    m.includes("load failed") ||
    m.includes("timeout") ||
    m.includes("time out") ||
    m.includes("aborterror") ||
    m.includes("etimedout") ||
    m.includes("econnrefused") ||
    m.includes("econnreset")
  );
}

export function isServerError(
  msg: string | undefined | null,
  status?: number
): boolean {
  if (typeof status === "number" && status >= 500 && status <= 599) return true;
  if (!msg) return false;
  const m = msg.toLowerCase();
  return (
    m.includes("internal server error") ||
    m.includes("500") ||
    m.includes("502") ||
    m.includes("503") ||
    m.includes("504") ||
    m.includes("bad gateway") ||
    m.includes("service unavailable") ||
    m.includes("gateway timeout") ||
    m.includes("no pudo procesar la solicitud")
  );
}

export function isClientError(
  msg: string | undefined | null,
  status?: number
): boolean {
  // 429 is retryable (rate-limit) — treat it like server error for UX.
  if (typeof status === "number" && status >= 400 && status <= 499 && status !== 429) {
    return true;
  }
  if (!msg) return false;
  const m = msg.toLowerCase();
  // 4xx signals in the message body; exclude "429" which is retryable.
  if (m.includes("429")) return false;
  return /\b(400|401|403|404|409|422)\b/.test(m);
}

/**
 * Build a user-facing retry hint based on the error class.
 * Returns both the message and whether a retry CTA should be offered.
 *
 * @param t - optional bilingual translation function from DashboardLangContext.
 *   Defaults to Spanish (current behaviour) when omitted.
 */
export function classifyErrorForUser(
  msg: string | undefined | null,
  status?: number,
  t: (en: string, es: string) => string = (_en, es) => es
): { message: string; canRetry: boolean; kind: "network" | "server" | "client" | "unknown" } {
  const base = msg ?? t("Could not process the request.", "No se pudo procesar la solicitud.");
  if (isClientError(msg, status)) {
    return {
      message: t("Could not process (4xx error). Check your message.", "No se pudo procesar (error 4xx). Revisá el mensaje."),
      canRetry: false,
      kind: "client",
    };
  }
  if (isNetworkError(msg)) {
    return {
      message: t("No connection. Tap Retry or wait for signal.", "Sin conexión. Tocá Reintentar o esperá señal."),
      canRetry: true,
      kind: "network",
    };
  }
  if (isServerError(msg, status)) {
    return {
      message: t("The server is having issues. Retry in a few seconds.", "El servidor está teniendo problemas. Reintenta en unos segundos."),
      canRetry: true,
      kind: "server",
    };
  }
  return { message: base, canRetry: false, kind: "unknown" };
}
