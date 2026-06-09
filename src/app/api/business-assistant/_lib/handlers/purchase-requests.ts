import { normalizeActionText, normalizeForMatching } from "../shared";
import type { PurchaseRequestDirectoryEntry } from "../types";

type AssistantRouteJson =
  | {
      answer: string;
      inputHint?: string;
      action?: unknown;
    }
  | null;

function normalizePurchaseRequestNumber(value: string) {
  const compact = value.replace(/\s+/g, "").toUpperCase();
  const prefixed = /^OC-?(\d{1,6})$/.exec(compact);
  if (prefixed?.[1]) {
    return `OC-${prefixed[1].padStart(6, "0")}`;
  }

  const digitsOnly = /^(\d{1,6})$/.exec(compact);
  if (digitsOnly?.[1]) {
    return `OC-${digitsOnly[1].padStart(6, "0")}`;
  }

  return compact;
}

function extractPurchaseRequestNumber(text: string) {
  const prefixedMatch = text.match(/\bOC\s*-\s*(\d{1,6})\b/i);
  if (prefixedMatch?.[1]) {
    return normalizePurchaseRequestNumber(`OC-${prefixedMatch[1]}`);
  }

  const genericMatch = text.match(
    /\b(?:solicitud(?:\s+de\s+compra)?|pedido(?:\s+de\s+compra)?)\s*(?:numero|número|num|#)?\s*(\d{1,6})\b/i
  );
  return genericMatch?.[1] ? normalizePurchaseRequestNumber(genericMatch[1]) : "";
}

function refersToSelectedPurchaseRequest(text: string) {
  const normalized = normalizeForMatching(text);
  return [
    "esta solicitud",
    "solicitud actual",
    "solicitud de compra actual",
    "solicitud seleccionada",
  ].some((term) => normalized.includes(term));
}

function refersToLatestPurchaseRequest(text: string) {
  const normalized = normalizeForMatching(text);
  return [
    "ultimo pedido",
    "ultima solicitud",
    "ultima solicitud de compra",
    "ultimo",
    "ultima",
  ].some((term) => normalized.includes(term));
}

export function looksLikePurchaseRequestLookupRequest(text: string) {
  const normalized = normalizeForMatching(text);
  const hasRequestReference =
    ["solicitud de compra", "solicitud", "pedido de compra", "pedido"].some((term) =>
      normalized.includes(normalizeForMatching(term))
    ) ||
    Boolean(extractPurchaseRequestNumber(text)) ||
    refersToSelectedPurchaseRequest(text) ||
    refersToLatestPurchaseRequest(text);
  const lookupTerms = [
    "buscar",
    "busca",
    "mostra",
    "mostrar",
    "mostrame",
    "ver",
    "revisar",
    "revisa",
    "abrir",
    "abre",
  ];

  return hasRequestReference && lookupTerms.some((term) => normalized.includes(term));
}

export function looksLikePurchaseRequestDownloadRequest(text: string) {
  const normalized = normalizeForMatching(text);
  const hasRequestReference =
    ["solicitud de compra", "solicitud", "pedido de compra", "pedido"].some((term) =>
      normalized.includes(normalizeForMatching(term))
    ) ||
    Boolean(extractPurchaseRequestNumber(text)) ||
    refersToSelectedPurchaseRequest(text) ||
    refersToLatestPurchaseRequest(text);
  const hasDownloadVerb = ["descargar", "descarga", "pdf"].some((term) => normalized.includes(term));
  return hasRequestReference && hasDownloadVerb;
}

export function looksLikePurchaseRequestWhatsappRequest(text: string) {
  const normalized = normalizeForMatching(text);
  const hasRequestReference =
    ["solicitud de compra", "solicitud", "pedido de compra", "pedido"].some((term) =>
      normalized.includes(normalizeForMatching(term))
    ) ||
    Boolean(extractPurchaseRequestNumber(text)) ||
    refersToSelectedPurchaseRequest(text) ||
    refersToLatestPurchaseRequest(text);
  const hasSendVerb = ["manda", "mandar", "envia", "enviar", "comparti", "compartir"].some((term) =>
    normalized.includes(term)
  );
  const hasWhatsappChannel = ["whatsapp", "wa", "proveedor"].some((term) => normalized.includes(term));

  return hasRequestReference && hasSendVerb && hasWhatsappChannel;
}

function getPurchaseRequestSupplierMatchScore(text: string, supplierName: string) {
  const normalizedText = normalizeForMatching(text);
  const normalizedSupplier = normalizeForMatching(supplierName);
  if (!normalizedSupplier) return 0;
  if (normalizedText.includes(normalizedSupplier)) return 100 + normalizedSupplier.length;

  const textTokens = new Set(normalizedText.split(/[^a-z0-9]+/).filter(Boolean));
  const supplierTokens = normalizedSupplier.split(/[^a-z0-9]+/).filter(Boolean);
  const overlap = supplierTokens.filter((token) => textTokens.has(token)).length;
  if (!overlap) return 0;

  return overlap * 10;
}

function buildPurchaseRequestClarification(
  reason: "no_requests" | "missing_reference" | "not_found" | "ambiguous" = "missing_reference",
  options: PurchaseRequestDirectoryEntry[] = []
) {
  if (reason === "ambiguous") {
    const topOptions = options
      .slice(0, 3)
      .map((request) => request.requestNumber)
      .join(", ");

    return {
      answer: `Encontré varias solicitudes posibles${topOptions ? `: ${topOptions}` : ""}. Decime el número exacto.`,
      inputHint: "Ej: abrí la solicitud OC-000123",
    };
  }

  if (reason === "not_found") {
    return {
      answer: "No encontré esa solicitud de compra.",
      inputHint: "Ej: buscá la solicitud OC-000123",
    };
  }

  if (reason === "missing_reference") {
    return {
      answer: "Decime qué solicitud de compra querés usar: la última, una por número o la de un proveedor.",
      inputHint: "Ej: buscá la solicitud OC-000123 o mostrame la última solicitud a Aceros",
    };
  }

  return {
    answer: "No tengo una solicitud de compra lista para usar. Primero generá una carga de stock con solicitud.",
    inputHint: "Ej: cargar 10 Filtro Bosch a 1200 con proveedor Aceros",
  };
}

function resolvePurchaseRequestReference(
  text: string,
  requests: PurchaseRequestDirectoryEntry[],
  latestPurchaseRequestId: string | null | undefined,
  preferSelectedFallback = false
) {
  if (requests.length === 0) {
    return { clarification: buildPurchaseRequestClarification("no_requests") };
  }

  const requestedNumber = extractPurchaseRequestNumber(text);
  if (requestedNumber) {
    const match = requests.find(
      (request) => normalizePurchaseRequestNumber(request.requestNumber) === requestedNumber
    );
    return match ? { request: match } : { clarification: buildPurchaseRequestClarification("not_found") };
  }

  if (refersToSelectedPurchaseRequest(text)) {
    const selected = latestPurchaseRequestId
      ? requests.find((request) => request.id === latestPurchaseRequestId) ?? null
      : null;
    return selected
      ? { request: selected }
      : { clarification: buildPurchaseRequestClarification("missing_reference") };
  }

  const scored = requests
    .map((request) => ({
      request,
      score: getPurchaseRequestSupplierMatchScore(text, request.supplierName),
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score);

  const best = scored[0];
  if (best) {
    const bestRequests = scored.filter((entry) => entry.score === best.score).map((entry) => entry.request);
    if (bestRequests.length > 1) {
      const wantsLatest = normalizeForMatching(text).includes("ultima");
      if (wantsLatest) {
        const sorted = [...bestRequests].sort((a, b) => new Date(b.issuedAt).getTime() - new Date(a.issuedAt).getTime());
        return { request: sorted[0] };
      }
      return { clarification: buildPurchaseRequestClarification("ambiguous", bestRequests) };
    }

    const candidateRequests = requests.filter(
      (request) => normalizeForMatching(request.supplierName) === normalizeForMatching(best.request.supplierName)
    );
    if (candidateRequests.length > 1 && !normalizeForMatching(text).includes("ultima")) {
      return { clarification: buildPurchaseRequestClarification("ambiguous", candidateRequests) };
    }

    const sortedCandidates = [...candidateRequests].sort((a, b) => new Date(b.issuedAt).getTime() - new Date(a.issuedAt).getTime());
    return { request: sortedCandidates[0] ?? best.request };
  }

  if (refersToLatestPurchaseRequest(text) && requests.length > 0) {
    const sorted = [...requests].sort((a, b) => new Date(b.issuedAt).getTime() - new Date(a.issuedAt).getTime());
    return { request: sorted[0] };
  }

  if (preferSelectedFallback && latestPurchaseRequestId) {
    const selected = requests.find((request) => request.id === latestPurchaseRequestId) ?? null;
    if (selected) {
      return { request: selected };
    }
  }

  return { clarification: buildPurchaseRequestClarification("missing_reference") };
}

export function handlePurchaseRequestDeterministicRequest(params: {
  text: string;
  requests: PurchaseRequestDirectoryEntry[];
  latestPurchaseRequestId?: string | null;
}): AssistantRouteJson {
  const { text, requests, latestPurchaseRequestId } = params;
  const normalizedLatestPurchaseRequestId = normalizeActionText(latestPurchaseRequestId);
  const selectedRequestId = normalizedLatestPurchaseRequestId || null;

  const purchaseRequestLookupRequested = looksLikePurchaseRequestLookupRequest(text);
  const purchaseRequestDownloadRequested = looksLikePurchaseRequestDownloadRequest(text);
  const purchaseRequestWhatsappRequested = looksLikePurchaseRequestWhatsappRequest(text);

  if (!(purchaseRequestLookupRequested || purchaseRequestDownloadRequested || purchaseRequestWhatsappRequested)) {
    return null;
  }

  const purchaseRequestResolution = resolvePurchaseRequestReference(
    text,
    requests,
    selectedRequestId,
    purchaseRequestDownloadRequested || purchaseRequestWhatsappRequested
  );
  if ("clarification" in purchaseRequestResolution) {
    return purchaseRequestResolution.clarification ?? null;
  }

  const resolvedRequest = purchaseRequestResolution.request;

  if (purchaseRequestWhatsappRequested) {
    return {
      answer: `Envío la solicitud ${resolvedRequest.requestNumber} al proveedor por WhatsApp.`,
      action: {
        type: "send_purchase_request_whatsapp",
        request: resolvedRequest,
      },
    };
  }

  if (purchaseRequestDownloadRequested) {
    return {
      answer: `Abro el PDF de la solicitud ${resolvedRequest.requestNumber}.`,
      action: {
        type: "download_purchase_request",
        request: resolvedRequest,
      },
    };
  }

  return {
    answer: `Te muestro la solicitud ${resolvedRequest.requestNumber}.`,
    action: {
      type: "select_purchase_request",
      request: resolvedRequest,
    },
  };
}
