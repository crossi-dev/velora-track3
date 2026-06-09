import { normalizeActionText } from "../shared";
import { extractSaleDraft } from "./sale-extractor";
import { containsSendKeyword } from "@/lib/sale-send-detection";
import { prisma } from "@/lib/prisma";
import { cloudLog } from "@/lib/cloud-logger";
import { publishReportEvent } from "@/app/api/_lib/agent-event-publishers";
import type { IntentHandler } from "./types";

// Deterministic confirmation prompt for register_sale success paths.
// Replaces the LLM-generated `answer` to prevent past-tense hallucinations
// like "Listo, registrada la venta..." before the user confirms the modal.
function buildSaleConfirmPrompt(
  customerName: string,
  items: Array<{ productName: string; quantity: number }>,
  total: number,
): string {
  const itemsText = items.map((it) => `${it.quantity} ${it.productName}`).join(", ");
  const totalSuffix = total > 0 ? ` por $${total}` : "";
  return `Te paso a confirmar la venta de ${itemsText} a ${customerName}${totalSuffix}.`;
}

// Handles `register_sale`: decides whether auto-send to WhatsApp should fire
// deterministically (based on user phrasing), resolves the sale draft
// server-side using the model-emitted `saleDraft` and business catalog, and
// emits the primary action plus the pre-resolved draft. The resolved draft
// lets the client skip the second /api/parse-sale roundtrip.
//
// Stock pre-confirm (Brief 2026-04-29 — "no guessing"):
//   Antes de emitir el saleDraft, consulta el inventario real para confirmar
//   que hay stock suficiente. Si falta, devuelve clarificación tipo
//   "no tengo stock suficiente" SIN primaryAction ni saleDraft. El check
//   real definitivo sigue siendo en /api/sales/create (sale-inventory.ts)
//   — esto es solo para no engañar al usuario en el chat con un saleDraft
//   que después va a fallar.

export const handleRegisterSale: IntentHandler = async ({
  text,
  safeIntent,
  parsed,
  answer,
  context,
  fullCatalogProducts,
  fullCatalogCustomers,
  businessId,
}) => {
  if (safeIntent !== "register_sale") return null;

  // Money-path guard: if the LLM returned a register_sale intent but could
  // not resolve a real product ID, do NOT emit the register_sale action.
  // A null matchedProductId means the model did not identify the product;
  // a non-null ID not in the catalog means the model hallucinated an ID.
  // In both cases return a clarification — the user must specify the product
  // explicitly before we open the sale modal.
  const rawMatchedProductId = normalizeActionText(parsed.matchedProductId) || null;
  const productInCatalog = rawMatchedProductId
    ? fullCatalogProducts.find((p) => p.id === rawMatchedProductId) ?? null
    : null;

  if (!rawMatchedProductId || !productInCatalog) {
    cloudLog({
      severity: "WARNING",
      component: "SaleHandler",
      action: "REJECTED_HALLUCINATED_ID",
      a2a_transfer: false,
      message: "register_sale (post-model): matchedProductId missing or not in catalog",
      data: {
        matchedProductId: rawMatchedProductId,
        matchedCustomerId: normalizeActionText(parsed.matchedCustomerId) || null,
      },
    });
    const productHint = normalizeActionText(parsed.product?.name);
    const clarification = productHint
      ? `No encontré "${productHint}" en el catálogo. ¿Cuál es el producto exacto que querés vender?`
      : "Decime qué producto exactamente querés vender para poder registrar la venta.";
    return { answer: clarification, primaryAction: null };
  }

  // Preflight: if no_sale_without_customer is active and the LLM draft has
  // no customer, clarify before emitting the confirm modal. The server
  // would 403 post-confirm — surfacing it here avoids the bad UX.
  const rawMatchedCustomerId = normalizeActionText(parsed.matchedCustomerId) || null;
  const noSaleWithoutCustomerRule = context?.activeRules?.find(
    (r) => r.trigger === "no_sale_without_customer",
  ) ?? null;
  if (noSaleWithoutCustomerRule && !rawMatchedCustomerId) {
    const msg = noSaleWithoutCustomerRule.message?.trim()
      ? `¿A qué cliente? ${noSaleWithoutCustomerRule.message}`
      : "¿A qué cliente hacemos la venta? El negocio requiere registrar el cliente en cada venta.";
    return { answer: msg, primaryAction: null };
  }

  const deterministicAutoSend = parsed.autoSend === true || containsSendKeyword(text);

  // Resolve the model's saleDraft against the catalog so the client can
  // open the sale confirmation UI directly without a second AI call.
  // When the draft is empty or unresolvable, we still emit the action and
  // let the legacy /api/parse-sale path handle it as a fallback.
  const extracted = await extractSaleDraft(parsed.saleDraft, fullCatalogProducts, fullCatalogCustomers, text, businessId);

  const baseResult = {
    answer,
    primaryAction: {
      type: "register_sale" as const,
      matchedProductId: rawMatchedProductId,
      matchedCustomerId: normalizeActionText(parsed.matchedCustomerId) || null,
      autoSend: deterministicAutoSend || undefined,
    },
  };

  if (extracted.kind === "resolved") {
    // Stock pre-confirm: leer inventario real ANTES de emitir el saleDraft.
    // Defensa contra falla en seguro: si la query falla, dejamos pasar el
    // saleDraft original — sale-inventory.ts hará el check final post-confirm.
    // Si no hay businessId (ej: tests legacy sin contexto), skipeamos.

    // Warn if some items couldn't be matched to catalog products — they will
    // fail at /api/sales/create. Better to surface the gap here than silently
    // emit a saleDraft that'll bounce later.
    const unmatchedItems = extracted.items.filter((it) => !it.productId);
    if (unmatchedItems.length > 0) {
      const names = unmatchedItems.map((it) => (it as { productName?: string }).productName ?? "item").join(", ");
      return {
        answer: `${answer}\n\nNo encontré en el catálogo: ${names}. Verificá el nombre e intentá de nuevo.`,
        primaryAction: null,
      };
    }

    try {
      const productIds = businessId
        ? extracted.items.map((it) => it.productId).filter((id): id is string => Boolean(id))
        : [];
      if (businessId && productIds.length > 0) {
        const productRows = await prisma.product.findMany({
          where: {
            id: { in: productIds },
            businessId,
          },
          select: {
            id: true,
            quantity: true,
            name: true,
            reorderThreshold: true,
          },
        });
        const stockByProduct = new Map(
          productRows.map((row) => [
            row.id,
            { quantity: row.quantity, name: row.name, reorderThreshold: row.reorderThreshold },
          ]),
        );

        const insufficient: Array<{ name: string; requested: number; available: number }> = [];
        const willCrossThreshold: Array<{ name: string; remainingAfterSale: number; threshold: number }> = [];

        for (const item of extracted.items) {
          const stock = stockByProduct.get(item.productId);
          if (!stock) continue; // Producto sin inventario tracked → dejar pasar.
          if (stock.quantity < item.quantity) {
            insufficient.push({
              name: stock.name,
              requested: item.quantity,
              available: stock.quantity,
            });
          } else {
            const remainingAfter = stock.quantity - item.quantity;
            if (remainingAfter <= stock.reorderThreshold) {
              willCrossThreshold.push({
                name: stock.name,
                remainingAfterSale: remainingAfter,
                threshold: stock.reorderThreshold,
              });
            }
          }
        }

        if (insufficient.length > 0) {
          // Stock insuficiente: clarificación al empleado SIN saleDraft.
          // El empleado puede ajustar cantidades o vender solo lo disponible.
          const lines = insufficient.map(
            (i) => `- ${i.name}: pedís ${i.requested}, quedan ${i.available}`,
          );
          const clarification =
            insufficient.length === 1
              ? `No tengo stock suficiente de ${insufficient[0].name}: pedís ${insufficient[0].requested} pero quedan ${insufficient[0].available}. ¿Vendemos solo lo disponible o ajustamos la cantidad?`
              : `No tengo stock suficiente para algunos items:\n${lines.join("\n")}\n¿Vendemos solo lo disponible o ajustamos cantidades?`;
          return {
            answer: clarification,
            primaryAction: null,
          };
        }

        // Stock suficiente pero alguno cruzando threshold post-venta:
        // mantener saleDraft, agregar warning cálido al answer.
        if (willCrossThreshold.length > 0) {
          const warningLines = willCrossThreshold.map(
            (w) => `${w.name} va a quedar en ${w.remainingAfterSale}`,
          );
          const warning = `\n\n(Heads up: ${warningLines.join(", ")} — abajo del nivel de reposición.)`;
          if (extracted.taxId) {
            void publishReportEvent({ businessId, actorEmployeeId: null, eventType: "cuit_provided", details: `CUIT/CUIL ingresado por empleado para cliente ${extracted.customer.name}: ${extracted.taxId}`, productName: null });
          }
          return {
            ...baseResult,
            answer: `${buildSaleConfirmPrompt(extracted.customer.name, extracted.items, extracted.total)}${warning}`,
            saleDraft: {
              customer: extracted.customer,
              taxId: extracted.taxId,
              items: extracted.items,
              total: extracted.total,
              skipped: extracted.skipped,
            },
          };
        }
      }
    } catch (stockCheckErr) {
      // Fail-open: el guardrail final está en sales/create. No bloqueamos.
      cloudLog({ severity: "WARNING", component: "Employee", action: "SALE_STOCK_PRECHECK_FAILED", a2a_transfer: false, message: "Stock pre-check failed; continuing with fail-open", businessId, data: { error: stockCheckErr instanceof Error ? stockCheckErr.message : String(stockCheckErr) } });
    }

    if (extracted.taxId) {
      void publishReportEvent({ businessId, actorEmployeeId: null, eventType: "cuit_provided", details: `CUIT/CUIL ingresado por empleado para cliente ${extracted.customer.name}: ${extracted.taxId}`, productName: null });
    }
    return {
      ...baseResult,
      answer: buildSaleConfirmPrompt(extracted.customer.name, extracted.items, extracted.total),
      saleDraft: {
        customer: extracted.customer,
        taxId: extracted.taxId,
        items: extracted.items,
        total: extracted.total,
        skipped: extracted.skipped,
      },
    };
  }

  if (extracted.kind === "ambiguous_customer") {
    return {
      ...baseResult,
      customerSelect: {
        query: extracted.query,
        candidates: extracted.candidates,
      },
    };
  }

  return baseResult;
};
