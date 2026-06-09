// Employee Agent instruction builder — extracted from employee-agent.ts.
//
// Builds the full instruction string passed to the ADK Agent, combining the
// system prompt, the business context block (catalog + time), and the
// conversational history. Kept separate to satisfy the 300-line file limit.

type HistoryTurn = { role: "user" | "model"; parts: Array<{ text: string }> };

interface BuildInstructionArgs {
  systemPrompt: string;
  history: HistoryTurn[];
}

interface BuildInstructionResult {
  fullInstruction: string;
}

type ProductEntry = { name: string; price: number; stock: number };
type CatalogProduct = { id: string; name: string; sku: string | null };
type ParsedContext = {
  business?: { name?: string; type?: string; currency?: string };
  products?: ProductEntry[];
  catalog?: { products?: CatalogProduct[] };
  currentTime?: string;
};

/**
 * Builds the full instruction string for the Employee ADK Agent.
 *
 * Separates the "Business context:" first turn from conversational history,
 * renders the catalog as a human-readable block (instead of raw JSON which
 * Flash parses unreliably), and appends the filtered conversational turns.
 */
export function buildEmployeeInstruction(args: BuildInstructionArgs): BuildInstructionResult {
  const { systemPrompt, history } = args;

  // Separamos el contexto del negocio (primer turno "Business context:") del
  // historial conversacional. Renderizamos el catálogo como bloque legible
  // para que Flash lo procese correctamente — el JSON crudo embebido como
  // "Usuario: Business context: {...}" no es parseado confiablemente por el
  // modelo, lo que resulta en matchedProductId: null aunque el producto exista.
  let businessContextBlock = "";
  let conversationalHistory = history;

  const firstTurn = history[0];
  if (
    firstTurn?.role === "user" &&
    firstTurn.parts[0]?.text?.startsWith("Business context:")
  ) {
    conversationalHistory = history.slice(1);
    // Extraer el JSON y renderizar como bloque legible de catálogo + contexto.
    const rawJson = firstTurn.parts[0].text.replace(/^Business context:\n/, "");
    try {
      const ctx: ParsedContext = JSON.parse(rawJson) as ParsedContext;
      const currency = ctx.business?.currency ?? "$";
      const businessName = ctx.business?.name ?? "";
      const businessType = ctx.business?.type ? ` (${ctx.business.type})` : "";

      // Build catalog lines enriched with product IDs for matchedProductId resolution.
      // Each catalog entry maps id→name; cross-ref with products[] for price+stock.
      const catalogProducts = ctx.catalog?.products ?? [];
      const productDetails = new Map<string, ProductEntry>(
        (ctx.products ?? []).map((p) => [p.name.toLowerCase(), p]),
      );
      const catalogLines = catalogProducts
        .map((cp) => {
          const detail = productDetails.get(cp.name.toLowerCase());
          const price = detail ? `${currency}${detail.price}` : "precio N/D";
          const stock = detail ? `${detail.stock} u.` : "stock N/D";
          return `- ${cp.name} (ID: ${cp.id}) | ${price} | stock: ${stock}`;
        })
        .join("\n");

      const timeInfo = ctx.currentTime ? `\nHora actual: ${ctx.currentTime}` : "";

      businessContextBlock =
        `\n\nCONTEXTO DEL NEGOCIO: ${businessName}${businessType}${timeInfo}\n` +
        `CATÁLOGO (usá el ID exacto en matchedProductId):\n${catalogLines || "(sin productos)"}`;
    } catch {
      // JSON parse falló — fallback al texto crudo para no perder contexto.
      businessContextBlock = `\n\nCONTEXTO DEL NEGOCIO:\n${rawJson}`;
    }
  }

  // Historial conversacional (sin el turno de contexto ya procesado arriba).
  // También filtramos el ACK "Contexto cargado." del model si está presente.
  const filteredHistory = conversationalHistory.filter(
    (turn) => !(turn.role === "model" && turn.parts[0]?.text?.trim() === "Contexto cargado."),
  );

  const historyBlock =
    filteredHistory.length > 0
      ? "\n\nHISTORIAL DEL CHAT (más viejo arriba):\n" +
        filteredHistory
          .map((turn) => {
            const role = turn.role === "model" ? "Velora" : "Usuario";
            const text = turn.parts.map((p) => p.text).join(" ");
            return `${role}: ${text}`;
          })
          .join("\n")
      : "";

  return { fullInstruction: `${systemPrompt}${businessContextBlock}${historyBlock}` };
}
