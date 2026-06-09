import { tLang } from "../DashboardLangContext";
import {
  containsSendKeyword,
} from "../../../../lib/sale-send-detection";
import {
  parseItemList,
  resolveProductName,
  type CreateBudgetData,
  type CreateBudgetLineItem,
  type ProductCatalogItem,
  type VeloraSingleCommand,
} from "./shared";

export type { CreateBudgetData, CreateBudgetLineItem };

// Verbs that introduce a budget. "hacé/hace un presupuesto", "armá un
// presupuesto", "prepará un presupuesto". Bare "presupuesto para X"
// also accepted.
const BUDGET_VERB_PREFIX_RE =
  /^(?:hace(?:le|me)?|hace|hacer|arma(?:le|me)?|arma|armar|prepara(?:le|me)?|prepara|preparar)\s+(?:un\s+)?presupuesto\s+/;

const BUDGET_BARE_PREFIX_RE = /^presupuesto\s+/;

// Detects the "para" prefix that introduces the customer name. The body
// AFTER this prefix is split into customer + items via splitCustomerAndBody.
const PARA_PREFIX_RE = /^para\s+/;

// Splits the body (after "para ") into customer name + items list. Two
// tiers, most specific first:
//
//   1. ":" — unambiguous separator. Use this for compound Spanish names
//      that contain " de " particles: "para Juan de la Cruz: 5 yerbas".
//
//   2. " de " — fallback when no colon. Split on the FIRST " de " so
//      "Carlos de 50 bolsas de cemento" splits as customer="Carlos",
//      items="50 bolsas de cemento". Customers with compound names
//      ("Juan de la Cruz") MUST use the colon separator (Tier 1) —
//      without it, "Juan de la Cruz de 5 yerbas" would parse as
//      customer="Juan", items="la Cruz de 5 yerbas".
function splitCustomerAndBody(body: string): { customerName: string; itemsBody: string } | null {
  // Tier 1: colon (unambiguous).
  const colonIdx = body.indexOf(":");
  if (colonIdx >= 0) {
    const customerName = body.slice(0, colonIdx).trim();
    const itemsBody = body.slice(colonIdx + 1).trim();
    if (customerName && itemsBody) return { customerName, itemsBody };
  }

  // Tier 2: first " de " (single-name customer + items list).
  const firstDe = body.match(/\s+de\s+/);
  if (firstDe && typeof firstDe.index === "number") {
    const customerName = body.slice(0, firstDe.index).trim();
    const itemsBody = body.slice(firstDe.index + firstDe[0].length).trim();
    if (customerName && itemsBody) return { customerName, itemsBody };
  }

  return null;
}

export function detectCreateBudget(
  normalized: string,
  products: ProductCatalogItem[],
): VeloraSingleCommand | null {
  // Strip one of the "hacé un presupuesto" / "presupuesto" prefixes.
  let afterPrefix: string | null = null;
  if (BUDGET_VERB_PREFIX_RE.test(normalized)) {
    afterPrefix = normalized.replace(BUDGET_VERB_PREFIX_RE, "").trim();
  } else if (BUDGET_BARE_PREFIX_RE.test(normalized)) {
    afterPrefix = normalized.replace(BUDGET_BARE_PREFIX_RE, "").trim();
  }
  if (!afterPrefix) return null;

  // Drop the trailing send keywords before the "para X: items" extraction
  // so they don't leak into the last item's product name. The presence of
  // the keyword still flips autoSendWhatsapp on the parsed output.
  const autoSendWhatsapp = containsSendKeyword(afterPrefix);
  const body = afterPrefix
    .replace(/\s+(?:y\s+)?(?:mandale|mandalo|mandaselo|mandá|manda|envia(?:le|me|selo)?|envia|enviar|wa|whatsapp|whats)\b.*$/, "")
    .trim();

  // Strip the "para " prefix; the rest is "<customer>(:|de) <items>".
  if (!PARA_PREFIX_RE.test(body)) return null;
  const afterPara = body.replace(PARA_PREFIX_RE, "");
  const split = splitCustomerAndBody(afterPara);
  if (!split) return null;

  const { customerName, itemsBody } = split;
  if (customerName.length < 2) return null;

  const parsedItems = parseItemList(itemsBody);
  if (parsedItems.length === 0) return null;

  const items: CreateBudgetLineItem[] = parsedItems.map((item) => {
    const match = resolveProductName(item.productName, products);
    return {
      productName: item.productName,
      productId: match?.id ?? null,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
    };
  });

  return {
    matched: true,
    intent: "create_budget",
    data: { customerName, items, autoSendWhatsapp },
  };
}

export function buildCreateBudgetConfirmMessage(
  data: CreateBudgetData,
  currency: string,
): string {
  const fmt = new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: currency || "ARS",
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
  const total = data.items.reduce((sum, item) => {
    const price = item.unitPrice ?? 0;
    return sum + price * item.quantity;
  }, 0);
  const itemCount = data.items.length;
  const noun = itemCount === 1 ? tLang("item", "ítem") : tLang("items", "ítems");
  const sendClause = data.autoSendWhatsapp ? tLang(" and send it via WhatsApp", " y enviarlo por WhatsApp") : "";
  return tLang(
    `Create budget for "${data.customerName}" with ${itemCount} ${noun} (total ${fmt.format(total)})${sendClause}?`,
    `¿Crear presupuesto para "${data.customerName}" con ${itemCount} ${noun} (total ${fmt.format(total)})${sendClause}?`
  );
}
