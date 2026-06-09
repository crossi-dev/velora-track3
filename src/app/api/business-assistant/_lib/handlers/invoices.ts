import { normalizeForMatching } from "../shared";
import type { InvoiceDirectoryEntry } from "../types";
import { hasInvoiceReference } from "./invoice-reference";

export { hasInvoiceReference } from "./invoice-reference";

type AssistantRouteJson =
  | {
      answer: string;
      inputHint?: string;
      action?: unknown;
    }
  | null;

function normalizeInvoiceNumber(value: string) {
  return value.replace(/\s+/g, "").toUpperCase();
}

function extractInvoiceNumber(text: string) {
  const match = text.match(/\b(\d{4}\s*-\s*\d{8})\b/);
  return match?.[1] ? normalizeInvoiceNumber(match[1]) : "";
}

function refersToCurrentInvoice(text: string) {
  const normalized = normalizeForMatching(text);
  return [
    "esta factura",
    "factura actual",
    "factura seleccionada",
  ].some((term) => normalized.includes(term));
}

export function looksLikeInvoiceLookupRequest(text: string) {
  const normalized = normalizeForMatching(text);
  // "comprobante fiscal" / "comprobantes fiscales" are synonyms for facturas
  // in AR usage. Without this, "mostrame los comprobantes fiscales" falls to
  // the LLM instead of routing through the invoice fast-path.
  // "recibo" added — AR informal synonym for invoice/receipt. Gap 10 — NLU
  // comprehension audit 2026-05-28 (agent ab2c390e63637a524).
  // M4 fix: hasInvoiceReference now guards "recibo" against payroll context.
  const hasInvoiceRef =
    hasInvoiceReference(normalized) ||
    Boolean(extractInvoiceNumber(text)) ||
    refersToCurrentInvoice(text);
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

  return hasInvoiceRef && lookupTerms.some((term) => normalized.includes(term));
}

export function looksLikeInvoiceDownloadRequest(text: string) {
  const normalized = normalizeForMatching(text);
  const hasInvoiceRef =
    normalized.includes("factura") || Boolean(extractInvoiceNumber(text)) || refersToCurrentInvoice(text);
  return hasInvoiceRef && ["descargar", "descarga", "pdf"].some((term) => normalized.includes(term));
}

export function looksLikeInvoiceWhatsappRequest(text: string) {
  const normalized = normalizeForMatching(text);
  const hasInvoiceRef =
    normalized.includes("factura") || Boolean(extractInvoiceNumber(text)) || refersToCurrentInvoice(text);
  const hasWhatsappChannel = ["whatsapp", "wa", "enlace"].some((term) => normalized.includes(term));
  const hasSendVerb = ["manda", "mandar", "envia", "enviar", "comparti", "compartir"].some((term) =>
    normalized.includes(term)
  );

  return hasInvoiceRef && hasWhatsappChannel && hasSendVerb;
}

function detectInvoiceStatusTarget(text: string): "issued" | "sent" | "paid" | null {
  const normalized = normalizeForMatching(text);
  if (["pagada", "pagado", "cobrada"].some((term) => normalized.includes(term))) {
    return "paid";
  }
  if (["enviada", "enviado"].some((term) => normalized.includes(term))) {
    return "sent";
  }
  if (["emitida", "emitido"].some((term) => normalized.includes(term))) {
    return "issued";
  }
  return null;
}

// Broader send detector that catches "enviá la factura al cliente X" even
// without a WhatsApp channel keyword. Used by detect.ts to route invoice-send
// requests that don't specify a channel (email, WhatsApp, etc.) to the invoice
// handler so it can respond gracefully instead of falling through to the LLM.
export function looksLikeInvoiceSendRequest(text: string): boolean {
  const normalized = normalizeForMatching(text);
  const hasInvoiceRef =
    normalized.includes("factura") ||
    normalized.includes("comprobante") ||
    Boolean(extractInvoiceNumber(text)) ||
    refersToCurrentInvoice(text);
  // Note: normalizeForMatching strips accents, so "enviá"→"envia" and "mandá"→"manda".
  // Duplicates removed (previously "manda" appeared twice, "enviá" duplicated "envia").
  const hasSendVerb = ["manda", "mandar", "envia", "enviar"].some(
    (term) => normalized.includes(term),
  );
  return hasInvoiceRef && hasSendVerb;
}

export function looksLikeInvoiceStatusRequest(text: string) {
  const normalized = normalizeForMatching(text);
  const hasInvoiceRef =
    normalized.includes("factura") || Boolean(extractInvoiceNumber(text)) || refersToCurrentInvoice(text);
  const hasStatusVerb = ["marc", "cambi", "actualiz"].some((term) => normalized.includes(term));
  return hasInvoiceRef && hasStatusVerb && Boolean(detectInvoiceStatusTarget(text));
}

function getInvoiceCustomerMatchScore(text: string, customerName: string) {
  const normalizedText = normalizeForMatching(text);
  const normalizedCustomer = normalizeForMatching(customerName);
  if (!normalizedCustomer) return 0;
  if (normalizedText.includes(normalizedCustomer)) return 100 + normalizedCustomer.length;

  const textTokens = new Set(normalizedText.split(/[^a-z0-9]+/).filter(Boolean));
  const customerTokens = normalizedCustomer.split(/[^a-z0-9]+/).filter(Boolean);
  const overlap = customerTokens.filter((token) => textTokens.has(token)).length;
  if (!overlap) return 0;

  return overlap * 10;
}

function buildInvoiceClarification(
  reason: "missing_reference" | "not_found" | "ambiguous" | "missing_status",
  options: InvoiceDirectoryEntry[] = []
) {
  if (reason === "missing_status") {
    return {
      answer: "Decime si querés marcar la factura como emitida, enviada o cobrada.",
      inputHint: "Ej: marcá la factura como cobrada",
    };
  }

  if (reason === "ambiguous") {
    const topOptions = options
      .slice(0, 3)
      .map((invoice) => invoice.invoiceNumber)
      .join(", ");

    return {
      answer: `Encontré varias facturas posibles${topOptions ? `: ${topOptions}` : ""}. Decime el número exacto.`,
      inputHint: "Ej: 0001-00001234",
    };
  }

  if (reason === "not_found") {
    return {
      answer: "No encontré esa factura. Decime el número exacto o abrí la factura que querés usar.",
      inputHint: "Ej: 0001-00001234",
    };
  }

  return {
    answer: "Decime qué factura querés usar. Podés pasarme el número exacto.",
    inputHint: "Ej: buscá la factura 0001-00001234",
  };
}

function resolveInvoiceReference(
  text: string,
  invoices: InvoiceDirectoryEntry[],
  activeInvoiceId: string | null | undefined,
) {
  if (invoices.length === 0) {
    return { clarification: { answer: "No hay facturas registradas todavía.", inputHint: "Registrá una venta para generar una factura." } };
  }

  const requestedInvoiceNumber = extractInvoiceNumber(text);
  if (requestedInvoiceNumber) {
    const match = invoices.find((invoice) => normalizeInvoiceNumber(invoice.invoiceNumber) === requestedInvoiceNumber);
    return match ? { invoice: match } : { clarification: buildInvoiceClarification("not_found") };
  }

  if (refersToCurrentInvoice(text)) {
    const activeInvoice = activeInvoiceId ? invoices.find((invoice) => invoice.id === activeInvoiceId) ?? null : null;
    return activeInvoice
      ? { invoice: activeInvoice }
      : { clarification: buildInvoiceClarification("missing_reference") };
  }

  const scored = invoices
    .map((invoice) => ({
      invoice,
      score: getInvoiceCustomerMatchScore(text, invoice.customerName),
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score);

  const best = scored[0];
  if (!best) {
    return { clarification: buildInvoiceClarification("missing_reference") };
  }

  const bestInvoices = scored.filter((entry) => entry.score === best.score).map((entry) => entry.invoice);
  if (bestInvoices.length > 1) {
    const wantsLatest = /\b(?:ultima|última)\b/i.test(text);
    if (wantsLatest) {
      const sorted = [...bestInvoices].sort((a, b) => new Date(b.issuedAt).getTime() - new Date(a.issuedAt).getTime());
      return { invoice: sorted[0] };
    }
    return { clarification: buildInvoiceClarification("ambiguous", bestInvoices) };
  }

  const candidateInvoices = invoices.filter(
    (invoice) => normalizeForMatching(invoice.customerName) === normalizeForMatching(best.invoice.customerName)
  );
  if (candidateInvoices.length > 1 && !/\b(?:ultima|última)\b/i.test(text)) {
    return { clarification: buildInvoiceClarification("ambiguous", candidateInvoices) };
  }

  const sortedCandidates = [...candidateInvoices].sort((a, b) => new Date(b.issuedAt).getTime() - new Date(a.issuedAt).getTime());
  return { invoice: sortedCandidates[0] ?? best.invoice };
}

export function handleInvoiceDeterministicRequest(params: {
  text: string;
  invoices: InvoiceDirectoryEntry[];
  activeInvoiceId?: string | null;
}): AssistantRouteJson {
  const { text, invoices, activeInvoiceId } = params;
  const invoiceLookupRequested = looksLikeInvoiceLookupRequest(text);
  const invoiceDownloadRequested = looksLikeInvoiceDownloadRequest(text);
  const invoiceWhatsappRequested = looksLikeInvoiceWhatsappRequest(text);
  const invoiceStatusRequested = looksLikeInvoiceStatusRequest(text);

  if (!(invoiceLookupRequested || invoiceDownloadRequested || invoiceWhatsappRequested || invoiceStatusRequested)) {
    return null;
  }

  const invoiceResolution = resolveInvoiceReference(text, invoices, activeInvoiceId);
  if ("clarification" in invoiceResolution) {
    return invoiceResolution.clarification ?? null;
  }

  const resolvedInvoice = invoiceResolution.invoice;

  if (invoiceStatusRequested) {
    const nextStatus = detectInvoiceStatusTarget(text);
    if (!nextStatus) {
      return buildInvoiceClarification("missing_status");
    }

    return {
      answer: `Marco la factura ${resolvedInvoice.invoiceNumber} como ${
        nextStatus === "paid" ? "cobrada" : nextStatus === "sent" ? "enviada" : "emitida"
      }.`,
      action: {
        type: "update_invoice_status",
        invoice: { id: resolvedInvoice.id, invoiceNumber: resolvedInvoice.invoiceNumber },
        status: nextStatus,
      },
    };
  }

  if (invoiceWhatsappRequested) {
    return {
      answer: `Abro la factura ${resolvedInvoice.invoiceNumber} en WhatsApp.`,
      action: {
        type: "send_invoice_whatsapp",
        invoice: { id: resolvedInvoice.id, invoiceNumber: resolvedInvoice.invoiceNumber, customerPhone: resolvedInvoice.customerPhone ?? null },
      },
    };
  }

  if (invoiceDownloadRequested) {
    return {
      answer: `Abro el PDF de la factura ${resolvedInvoice.invoiceNumber}.`,
      action: {
        type: "download_invoice",
        invoice: { id: resolvedInvoice.id, invoiceNumber: resolvedInvoice.invoiceNumber },
      },
    };
  }

  return {
    answer: `Te muestro la factura ${resolvedInvoice.invoiceNumber}.`,
    action: {
      type: "select_invoice",
      invoice: { id: resolvedInvoice.id, invoiceNumber: resolvedInvoice.invoiceNumber },
    },
  };
}
