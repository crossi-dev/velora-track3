import { findBestCustomerMatch } from "../../../api/business-assistant/_lib/handlers/customer-matching";
import { containsSendKeyword, stripSendKeywordTail } from "../../../../lib/sale-send-detection";
import {
  parseItemList,
  resolveProductName,
  splitProductAndCustomer,
  type CustomerCatalogItem,
  type ProductCatalogItem,
  type SaleLineItem,
  type VeloraSingleCommand,
} from "./shared";

const SALE_VERBS_RE =
  /\b(vendi|vendele|vendeme|vendo|factura(?:le|me)?|anota(?:le|me)?|registra(?:le|me)?)\b/;

export function detectRegisterSale(
  normalized: string,
  products: ProductCatalogItem[],
  customers: CustomerCatalogItem[]
): VeloraSingleCommand | null {
  const verbMatch = normalized.match(SALE_VERBS_RE);
  if (!verbMatch || verbMatch.index === undefined) return null;

  const afterVerb = normalized.slice(verbMatch.index + verbMatch[0].length).trim();
  if (!afterVerb) return null;

  const { productName: itemsBody, customerName: rawCustomerName } = splitProductAndCustomer(afterVerb);
  // "vendí X a Carlos mandale wpp" → split leaves "Carlos mandale wpp" as
  // the customer fragment. Strip the send-keyword tail so the matcher gets
  // just "Carlos" and finds the contact instead of returning no-match.
  const customerName = rawCustomerName ? stripSendKeywordTail(rawCustomerName) : rawCustomerName;

  const parsedItems = parseItemList(itemsBody);
  if (parsedItems.length === 0) return null;

  const items: SaleLineItem[] = parsedItems.map((item) => {
    const match = resolveProductName(item.productName, products);
    return {
      productName: item.productName,
      productId: match?.id ?? null,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
    };
  });

  let customerId: string | null = null;
  let ambiguousCustomer = false;
  if (customerName) {
    const customerResult = findBestCustomerMatch(customerName, customers);
    if (customerResult.ambiguous) ambiguousCustomer = true;
    else if (customerResult.match) customerId = customerResult.match.id;
  }

  return {
    matched: true,
    intent: "register_sale",
    data: {
      items,
      customerName,
      customerId,
      ambiguousCustomer,
      autoSendWhatsapp: containsSendKeyword(normalized),
    },
  };
}
