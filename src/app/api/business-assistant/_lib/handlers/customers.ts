import { chooseLongerText, normalizeActionText } from "../shared";
import type { AssistantTaskModelResponse } from "../types";
import { extractCustomerFromRequest } from "./customer-extraction";
import { isWeakCustomerName, looksLikeCreateCustomerRequest } from "./customer-intent";

export { extractCustomerFromRequest } from "./customer-extraction";
export { extractCustomerEditFromRequest } from "./customer-extraction";
export { looksLikeCreateCustomerRequest, looksLikeEditCustomerRequest, isWeakCustomerName } from "./customer-intent";
export { resolveCustomerEditRequest } from "./customer-edit-resolve";

export function resolveCustomerCreateRequest(
  text: string,
  parsed: AssistantTaskModelResponse,
  locale: string,
  options?: { force?: boolean }
) {
  const customerCreateRequested = looksLikeCreateCustomerRequest(text);
  const fallbackCustomer = customerCreateRequested ? extractCustomerFromRequest(text) : null;
  const customer = {
    name: chooseLongerText(normalizeActionText(parsed.customer?.name), fallbackCustomer?.name || ""),
    phone: normalizeActionText(parsed.customer?.phone) || fallbackCustomer?.phone || "",
    email: normalizeActionText(parsed.customer?.email) || fallbackCustomer?.email || "",
    taxId: normalizeActionText(parsed.customer?.taxId) || fallbackCustomer?.taxId || "",
    // Fields below are only extracted from raw text (the LLM schema does not
    // yet emit them); always prefer fallback values from the text extractor.
    dni: fallbackCustomer?.dni || "",
    address: fallbackCustomer?.address || "",
    postalCode: fallbackCustomer?.postalCode || "",
    city: fallbackCustomer?.city || "",
  };
  const hasCustomerSignal =
    customerCreateRequested ||
    Boolean(customer.name || customer.phone || customer.email || customer.taxId);
  const customerNameClarification = {
    answer: "No pude identificar el nombre del cliente. ¿Cómo se llama?",
    inputHint: "Ej: María Gómez",
  };
  const customerIntentClarification = {
    answer: "No pude saber si querés crear o editar un cliente. ¿Qué querés hacer?",
    inputHint: "Ej: crear cliente María Gómez",
  };

  if (!hasCustomerSignal && !options?.force) {
    return null;
  }

  if (!customerCreateRequested) {
    return { clarification: customerIntentClarification };
  }

  if (customer.name && !isWeakCustomerName(customer.name)) {
    return {
      action: {
        type: "create_customer" as const,
        customer,
      },
    };
  }

  // Allow creation with only phone/email/taxId — name is now optional.
  // Omit name from the payload when absent so the API schema (name?: string min(1))
  // does not reject the body. The DB mutation layer derives a display name from
  // phone/email/taxId when name is undefined.
  if (customer.phone || customer.email || customer.taxId) {
    const customerPayload = customer.name
      ? customer
      : {
          phone: customer.phone,
          email: customer.email,
          taxId: customer.taxId,
          dni: customer.dni,
          address: customer.address,
          postalCode: customer.postalCode,
          city: customer.city,
        };
    return {
      action: {
        type: "create_customer" as const,
        customer: customerPayload,
      },
    };
  }

  return { clarification: customerNameClarification };
}
