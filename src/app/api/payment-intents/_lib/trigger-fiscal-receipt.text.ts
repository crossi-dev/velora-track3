// trigger-fiscal-receipt.text — receipt body construction from the structured
// `emit_invoice` tool result. Kept in a sibling so trigger-fiscal-receipt.ts
// stays under the 300-line area limit.
//
// Google 2026 standard: never depend on LLM prose for facts that already
// travel in a structured dataPart. The agent may transcribe internal tool
// fields (e.g. setupGuidance) verbatim into the text reply; by rebuilding
// the customer-visible body from the typed result, we both prevent leaks
// and guarantee a deterministic shape.

/** Builds receipt text from the structured emit_invoice tool result. */
export function buildStructuredReceiptText(
  result: Record<string, unknown>,
  isSandbox: boolean,
): string {
  const tipo = typeof result.tipo === "string" ? result.tipo : "";
  const numero = result.numero != null ? String(result.numero) : "";
  const cae = typeof result.cae === "string" ? result.cae : "";
  const vencimiento = typeof result.vencimiento === "string" ? result.vencimiento : "";
  const amount =
    typeof result.amountARS === "number"
      ? result.amountARS.toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : String(result.amountARS ?? "");
  const concept = typeof result.concept === "string" ? result.concept : "";

  const lines: string[] = [];
  if (tipo && numero) lines.push(`Comprobante tipo ${tipo} N° ${numero}`);
  if (amount) lines.push(`Total: $ ${amount}`);
  if (concept) lines.push(`Concepto: ${concept}`);
  if (cae) lines.push(`CAE: ${cae}`);
  if (vencimiento) lines.push(`Vto. CAE: ${vencimiento}`);
  if (isSandbox) lines.push("(sandbox — sin validez fiscal)");
  return lines.join("\n");
}
