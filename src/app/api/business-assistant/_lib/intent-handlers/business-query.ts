import { NextResponse } from "next/server";
import { cloudLog } from "@/lib/cloud-logger";
import { redactInput } from "@/lib/redact-pii";
import { buildInventorySummaryAnswer, buildProductStockAnswer } from "../handlers/inventory";
import { formatMoney, normalizeForMatching } from "../shared";
import type { IntentHandler } from "./types";
import { PRICE_QUERY_RE, STOCK_QUERY_RE } from "../nlu/query-regex";

export { PRICE_QUERY_RE, STOCK_QUERY_RE };

export const INVENTORY_WIDE_PATTERNS: RegExp[] = [
  /\bstock\s+completo\b/,
  /\binventario(?:\s+completo)?\b/,
  /\btodo\s+el\s+(?:stock|inventario)\b/,
  /\btodos?\s+los\s+productos\b/,
  /\bcatalogo(?:\s+completo)?\b/,
  /\bque\s+productos\s+(?:tengo|tenemos|hay)\b/,
  /\bque\s+hay\s+en\s+(?:stock|inventario)\b/,
  // General stock queries without specifying a product
  /\bcuanto\s+(?:stock|inventario)\s+(?:tengo|hay|tiene)\b/,
  /\bque\s+tengo\s+en\s+stock\b/,
  /\bque\s+tengo\s+(?:de\s+)?stock\b/,
  /\bmostra(?:me)?\s+(?:el\s+)?(?:stock|inventario)\b/,
  /\bcuanto\s+tengo\s+en\s+stock\b/,
  // "decime el stock", "dame el inventario", "ver stock", "el stock"
  /\bdecime\s+(?:el\s+)?(?:stock|inventario)\b/,
  /\bdame\s+(?:el\s+)?(?:stock|inventario)\b/,
  /\bver?\s+(?:el\s+)?(?:stock|inventario)\b/,
  /^(?:el\s+)?stock\s*$/,
];

// Customer history — "historial de Juan", "qué compró María", "ventas de López"
const CUSTOMER_HISTORY_PATTERNS: RegExp[] = [
  /\b(?:historial|compras?|ventas?)\s+(?:de|del?)\s+([^?]+)/i,
  /\bqu[eé]\s+compr[oó]\s+(.+)/i,
  /\bcompr[oó]\s+(?:de|del?)\s+([^?]+)/i,
];


function buildCustomerHistoryAnswer(
  customerNameRaw: string,
  recentSales: NonNullable<import("../types").AssistantBusinessPromptContext["recentSales"]>,
  currency: string,
  locale: string,
): string | null {
  const needle = normalizeForMatching(customerNameRaw);
  if (!needle) return null;
  const sales = recentSales.filter((s) => s.customer && normalizeForMatching(s.customer).includes(needle));
  if (sales.length === 0) return null;

  const fmt = (n: number) => formatMoney(n, currency, locale);
  const total = sales.reduce((sum, s) => sum + Number(s.totalAmount), 0);
  const lines = sales.slice(0, 8).map((s) => {
    const date = new Date(s.date).toLocaleDateString("es-AR", { day: "numeric", month: "short" });
    const items = s.items.map((i) => `${i.quantity}× ${i.product}`).join(", ");
    return `· ${date}: ${items} (${fmt(Number(s.totalAmount))})`;
  });
  const header = `Últimas compras de ${customerNameRaw} — total reciente: ${fmt(total)}`;
  return [header, ...lines].join("\n");
}

export const handleBusinessQuery: IntentHandler = ({ safeIntent, text, answer, productInfoDirectory, context, locale }) => {
  if (safeIntent !== "business_query") return null;

  const normalizedText = normalizeForMatching(text);
  const userAskedPrice = PRICE_QUERY_RE.test(normalizedText);
  const userAskedStock = STOCK_QUERY_RE.test(normalizedText);
  const asksForFullInventory = INVENTORY_WIDE_PATTERNS.some((re) => re.test(normalizedText));

  // Customer history query — "qué compró Juan", "historial de María", etc.
  const historyMatch = CUSTOMER_HISTORY_PATTERNS.map((re) => text.match(re)).find(Boolean);
  if (historyMatch && context.recentSales) {
    // Guard: historyMatch[1] is the capture group — all patterns define one,
    // but we guard against undefined to avoid a runtime throw on bad regex state.
    const customerName = (historyMatch[1] ?? "").trim();
    const historyAnswer = buildCustomerHistoryAnswer(customerName, context.recentSales, context.business.currency, locale);
    if (historyAnswer) {
      return NextResponse.json({ answer: historyAnswer, actions: [] });
    }
  }

  if (asksForFullInventory) {
    cloudLog({ severity: "INFO", component: "System", action: "BUSINESS_QUERY_INVENTORY_RESCUE", a2a_transfer: false, message: "post-handler returned authoritative full inventory", data: { text: redactInput(text, 200) } });
    const fallbackProducts = productInfoDirectory.map((p) => ({ name: p.name, price: p.price, stock: p.stock }));
    const summaryAnswer = buildInventorySummaryAnswer(
      {
        business: context.business,
        inventorySummary: context.inventorySummary,
        products: context.products ?? fallbackProducts,
      },
      locale
    );
    return NextResponse.json({ answer: summaryAnswer, actions: [] });
  }

  // Per-product authoritative override. Picks the right answer (stock vs price)
  // based on what the user actually asked. Previously always overrode with
  // stock, which clobbered correct price answers.
  //
  // Resolución del producto: SIEMPRE preferir el producto mencionado en la
  // pregunta del USUARIO antes del answer del LLM. Antes iterábamos products
  // y el primer match contra `answer` ganaba — si el LLM mencionaba ambos
  // ("tenés 5 tuercas y 2 destornilladores"), perdía el alfabético primero
  // (destornilladores) aunque el user hubiera preguntado por tuercas.
  // Patrón Fast Path / Slow Path: lookup determinístico contra catálogo
  // finito sobre el texto del user antes de cualquier inferencia del LLM.
  const normalizedAnswer = normalizeForMatching(answer);
  if (/\d/.test(answer) && (userAskedStock || userAskedPrice)) {
    const candidates = productInfoDirectory
      .map((p) => ({ product: p, normalizedName: normalizeForMatching(p.name) }))
      .filter((c) => c.normalizedName.length > 0);

    const inUserText = candidates.find((c) => normalizedText.includes(c.normalizedName));
    const inAnswer = inUserText ? null : candidates.find((c) => normalizedAnswer.includes(c.normalizedName));
    const winner = inUserText ?? inAnswer;

    if (winner) {
      const product = winner.product;
      if (userAskedPrice) {
        const priceLabel = formatMoney(product.price, context.business.currency, locale);
        const authoritative = `${product.name} vale ${priceLabel}.`;
        cloudLog({ severity: "INFO", component: "System", action: "BUSINESS_QUERY_PRICE_RESCUE", a2a_transfer: false, message: "post-handler asserted authoritative price", data: { product: product.name } });
        return NextResponse.json({ answer: authoritative, actions: [] });
      }
      if (userAskedStock) {
        const authoritative = buildProductStockAnswer(product, locale);
        cloudLog({ severity: "INFO", component: "System", action: "BUSINESS_QUERY_STOCK_RESCUE", a2a_transfer: false, message: "post-handler asserted authoritative stock", data: { product: product.name } });
        return NextResponse.json({ answer: authoritative, actions: [] });
      }
    }
  }
  return NextResponse.json({ answer, actions: [] });
};
