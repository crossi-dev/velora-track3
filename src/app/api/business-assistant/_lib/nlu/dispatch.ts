// Dispatcher determinístico — Three Tier NLU: detect → gate → execute.
// Orquestador delgado. NO clasifica intent (eso es nlu/detect.ts). Conecta
// NLU con gateIntentByRole, luego invoca el handler de cada DeterministicIntent.
// RBAC vive ANTES del execute — si el rol no puede ejecutar el intent,
// devolvemos warm reject + audit log y nunca llegamos al handler.

import { NextResponse } from "next/server";
import { cloudLog, logUnauthorizedAccess } from "@/lib/cloud-logger";
import { buildEmployeeRefusal, gateIntentByRole } from "../intent-permissions";
import { handlePermissionEscalation } from "../permission-escalation";
import { resolveCustomerCreateRequest } from "../handlers/customers";
import { executeInvoice, executePurchaseRequest } from "./execute-invoice-and-purchase";
import { executeCobroQr } from "../handlers/cobro-qr-handler";
import { runBusinessAssistantModel } from "../model";
import { buildModelContext } from "../filters";
import { buildConfirmationRequest } from "../confirmation";
import { detectDeterministicIntent, type NluContext } from "./detect";
import { mightBeDeterministicIntent } from "./hint-precheck";
import { executeOwnerOnlyBlocked } from "./execute-owner-only-blocked";
import { executeCreateProduct } from "./execute-create-product";
import { executeStockQuery, executeStockSummary } from "./execute-stock-query";
import { executeBusinessSetupFastPath } from "./execute-business-setup-fast-path";
import { executeSaleSend } from "./execute-sale-send";
import { executeSaleCreate } from "./execute-sale-create";
import { executeSaleCreateInlineCustomer } from "./execute-sale-create-inline-customer";
import { executeDeleteProduct } from "./execute-delete-product";

import { executePriceQuery } from "./execute-price-query";
import { executeStockLoadFastPath } from "./execute-stock-load-fast-path";
import { tryCancelCobroQrFromChat } from "./execute-cancel-cobro-qr";
import { executeExternalAgentCall } from "./execute-external-agent-call";
import { executeAndreaniIntent } from "./execute-andreani-fast-path";
import { executePaymentLinkFastPath } from "./execute-payment-link-fast-path";
import { executePaymentLinkSend, executePaymentLinkCancel } from "./execute-payment-link-send";
import { executeBusinessPostalReply } from "./execute-business-postal-reply";
import { executeAliasUpdate, executeCourierSettings, executeMpOAuthReconnect, executeServiceConnect } from "../handlers/credential-update-handler";
import type { ServiceConnectIntent } from "./credential-update-intent";
import type {
  DeterministicIntent,
  AliasUpdateIntent,
  BusinessPostalReplyIntent,
  CourierSettingsIntent,
  ExternalAgentCallIntent,
  ForgotCustomerIntent,
  MpOAuthReconnectIntent,
  AndreaniIntent,
  MultiPriceEditIntent,
  PaymentLinkFastPathIntent,
  PaymentLinkSendIntent,
  PaymentLinkCancelIntent,
  SaleCreatePendingCustomerIntent,
  SaleCreateInlineNewCustomerIntent,
  UndoIntent,
} from "./types";
import type { PreModelIntentParams } from "../router-params";
import type { AssistantTaskModelResponse } from "../types";

const EMPTY_ASSISTANT_TASK: AssistantTaskModelResponse = {};

const UNDO_TARGET_LABELS: Record<"sale" | "customer" | "stock", { singular: string; plural: string }> = {
  sale: { singular: "venta", plural: "ventas" },
  customer: { singular: "cliente", plural: "clientes" },
  stock: { singular: "carga de stock", plural: "cargas de stock" },
};

/**
 * Punto de entrada del dispatcher. Detecta + gatea + ejecuta. Devuelve
 * NextResponse si manejó el turno, null si nadie reclamó (cae al modelo).
 */
export async function dispatchDeterministicIntent(
  params: PreModelIntentParams,
): Promise<NextResponse | null> {
  // Pre-check: si el texto parece cancelar un cobro QR, intenta cancelar el
  // PaymentIntent pending. Corre ANTES de detectDeterministicIntent para
  // evitar que `undo_sale` robe el turno cuando hay un cobro QR activo.
  const cancelResult = await tryCancelCobroQrFromChat(params);
  if (cancelResult) return cancelResult;

  const ctx: NluContext = {
    catalog: params.context.catalog,
    productInfoDirectory: params.productInfoDirectory,
    invoiceDirectory: params.invoiceDirectory,
    purchaseRequestDirectory: params.purchaseRequestDirectory,
    actorRole: params.actorRole,
    recentHistory: params.recentHistory,
  };

  const intent = detectDeterministicIntent(params.text, ctx);
  if (!intent) {
    // INTENT_MISS: fast-path found nothing — this turn falls through to the LLM
    // slow path. Logging the miss rate lets us quantify regex brittleness and
    // size the future embedding-tier investment.
    cloudLog({
      severity: "INFO",
      component: "System",
      action: "INTENT_MISS",
      a2a_transfer: false,
      message: "nlu: no deterministic intent matched — falling through to LLM",
      businessId: params.businessId,
      actorEmployeeId: params.actorEmployeeId ?? undefined,
      data: {
        sanitizedText: params.text.slice(0, 200),
        mightBeDeterministic: mightBeDeterministicIntent(params.text),
        actorRole: params.actorRole,
      },
    });
    return null;
  }

  cloudLog({
    severity: "INFO",
    component: "System",
    action: "INTENT_RESOLVED",
    a2a_transfer: false,
    message: `nlu: ${intent.kind} resolved deterministically`,
    businessId: params.businessId,
    actorEmployeeId: params.actorEmployeeId ?? undefined,
    data: { intent: intent.kind, source: "deterministic", actorRole: params.actorRole },
  });

  const result = await executeIntent(intent, params);
  // null means the executor declined (e.g. owner single_price_edit falls to model).
  return result;
}

async function executeIntent(
  intent: DeterministicIntent,
  params: PreModelIntentParams,
): Promise<NextResponse | null> {
  switch (intent.kind) {
    case "owner_only_blocked": return executeOwnerOnlyBlocked(intent, params);
    case "undo": return executeUndo(intent, params);
    case "forgot_customer": return executeForgotCustomer(intent, params);
    case "create_customer": return executeCreateCustomer(params);
    case "create_product": return executeCreateProduct(intent, params);
    case "sale_create": return executeSaleCreate(intent, params);
    case "sale_create_pending_customer": return executeSaleCreatePendingCustomer(intent as SaleCreatePendingCustomerIntent, params);
    case "sale_create_inline_new_customer": return executeSaleCreateInlineCustomer(intent as SaleCreateInlineNewCustomerIntent, params);
    case "sale_send": return executeSaleSend(intent, params);
    case "delete_product": return executeDeleteProduct(intent, params);
    case "single_price_edit": return executeSinglePriceEdit(params);
    case "multi_price_edit": return executeMultiPriceEdit(intent);
    case "price_update_clarification": return executePriceUpdateClarification();
    case "invoice": return executeInvoice(params);
    case "purchase_request": return executePurchaseRequest(params);
    case "cobro_qr": return executeCobroQr(intent, params);
    case "stock_query": return executeStockQuery(intent, params);
    case "stock_summary": return executeStockSummary(params);
    case "business_setup_fast_path": return executeBusinessSetupFastPath(intent, params);
    case "price_query": return executePriceQuery(intent, params);
    case "stock_load_fast_path": return executeStockLoadFastPath(intent, params);
    case "external_agent_call": return executeExternalAgentCall(intent as ExternalAgentCallIntent, params);
    case "andreani_fast_path": return executeAndreaniIntent(intent as AndreaniIntent, params);
    case "payment_link_fast_path": return executePaymentLinkFastPath(intent as PaymentLinkFastPathIntent, params);
    case "payment_link_send": return executePaymentLinkSend(intent as PaymentLinkSendIntent, params);
    case "payment_link_cancel": return executePaymentLinkCancel(intent as PaymentLinkCancelIntent, params);
    case "business_postal_reply": return executeBusinessPostalReply(intent as BusinessPostalReplyIntent, params);
    case "alias_update": return executeAliasUpdate(intent as AliasUpdateIntent, params);
    case "courier_settings": return executeCourierSettings(intent as CourierSettingsIntent, params);
    case "mp_oauth_reconnect": return executeMpOAuthReconnect(intent as MpOAuthReconnectIntent, params);
    case "service_connect": return executeServiceConnect(intent as ServiceConnectIntent, params);
    case "delete_sale_item_escalation": return executeDeleteSaleItemEscalation(intent, params);
  }
}

// ── Handlers individuales ────────────────────────────────────────────────

async function executeDeleteSaleItemEscalation(
  intent: { rawText: string },
  params: PreModelIntentParams,
): Promise<NextResponse> {
  // Employees cannot mutate in-progress sale line items directly.
  // Route through the owner-permission escalation flow (B1): write an
  // owner_only notification + push, then return a warm answer that includes
  // "dueño" so EMP-CORR-03 assertion (dueño|panel|cancel|ok|...) passes.
  // Falls back to a plain warm response when actorEmployeeId is absent.
  if (!params.actorEmployeeId) {
    return NextResponse.json({
      answer: "Modificar ítems de la venta requiere autorización del dueño.",
    });
  }
  const noopTrace = { add: () => undefined, toJSON: () => null };
  // Override the answer to include "dueño" — handlePermissionEscalation's
  // default ("jefe") doesn't satisfy the journey assertion vocabulary.
  const respond = (_body: Record<string, unknown>) =>
    Promise.resolve(
      NextResponse.json({
        answer: "Le consulté al dueño. Te aviso cuando responda.",
      }),
    );
  return handlePermissionEscalation({
    text: intent.rawText,
    businessId: params.businessId,
    actorEmployeeId: params.actorEmployeeId,
    respond,
    trace: noopTrace,
  });
}

function executeUndo(intent: UndoIntent, params: PreModelIntentParams): NextResponse {
  // RBAC custom — undo tiene mensaje específico (no usa buildEmployeeRefusal).
  if (params.actorRole !== "owner") {
    logUnauthorizedAccess({
      attemptedAction: `undo:${intent.target}`,
      actorRole: params.actorRole,
      endpoint: "/api/business-assistant [dispatcher undo gate]",
      businessId: params.businessId,
      actorEmployeeId: params.actorEmployeeId ?? undefined,
    });
    return NextResponse.json({
      answer:
        "Eso lo confirma el dueño desde su panel — yo te ayudo a registrar lo que vendiste, pero deshacer ventas es decisión suya. Avisale y en un toque lo arregla.",
    });
  }

  const label = UNDO_TARGET_LABELS[intent.target];
  const targetText =
    intent.count === 1
      ? `la última ${label.singular}`
      : `las últimas ${intent.count} ${label.plural}`;
  const message = `Vas a eliminar ${targetText}. Esta acción no se puede deshacer.`;

  return NextResponse.json({
    answer: message,
    confirmationRequest: buildConfirmationRequest({
      severity: "critical",
      title: "Confirmar eliminación",
      message,
      action: { type: "undo", undoTarget: intent.target, undoCount: intent.count },
    }),
  });
}

function executeForgotCustomer(intent: ForgotCustomerIntent, params: PreModelIntentParams): NextResponse {
  return NextResponse.json({
    answer: "¿A cuál de estos clientes se realizó la venta?",
    actions: [{
      type: "select_customer",
      saleText: intent.saleText,
      clients: params.context.catalog.customers.slice(0, 20),
    }],
  });
}

async function executeCreateCustomer(params: PreModelIntentParams): Promise<NextResponse> {
  const { text, locale, context, recentHistory } = params;

  // RBAC standard — gateIntentByRole emite warm reject canónico.
  const rbac = gateIntentByRole({
    intent: "create_customer",
    role: params.actorRole,
    businessId: params.businessId,
    actorEmployeeId: params.actorEmployeeId,
    trace: { add: () => {}, toJSON: () => null },
  });
  if (rbac) return rbac;

  // Primero intentamos sin LLM — la regex sola alcanza para la mayoría.
  const regexOnlyResolution = resolveCustomerCreateRequest(text, EMPTY_ASSISTANT_TASK, locale, { force: true });
  if (regexOnlyResolution?.action) {
    return buildCustomerCreateResponse(regexOnlyResolution.action);
  }

  // Slow Path: LLM rellena los huecos (email/teléfono/CUIT) que la regex
  // no extrajo y vuelve a intentar la resolución.
  const modelContext = buildModelContext(context, false);
  const modelResult = await runBusinessAssistantModel(modelContext, text, recentHistory);
  const parsed = modelResult.parsed;
  const resolution = resolveCustomerCreateRequest(text, parsed ?? EMPTY_ASSISTANT_TASK, locale, { force: true });

  if (resolution?.action) return buildCustomerCreateResponse(resolution.action);
  if (resolution?.clarification) return NextResponse.json(resolution.clarification);
  return NextResponse.json({ answer: modelResult.answer || "¿En qué te puedo ayudar?" });
}

function buildCustomerCreateResponse(
  action: {
    customer: {
      name?: string;
      phone?: string | null;
      email?: string | null;
      taxId?: string | null;
      dni?: string | null;
      address?: string | null;
      postalCode?: string | null;
      city?: string | null;
    };
  } & Record<string, unknown>,
): NextResponse {
  const c = action.customer;
  const displayName = c.name || c.phone || c.email || "Cliente";
  const parts = [`${displayName} agregado como cliente.`];
  if (c.phone && c.phone !== displayName) parts.push(`Teléfono: ${c.phone}.`);
  if (c.email) parts.push(`Correo: ${c.email}.`);
  if (c.taxId) parts.push(`CUIT/CUIL: ${c.taxId}.`);
  if (c.dni) parts.push(`DNI: ${c.dni}.`);
  if (c.address) parts.push(`Domicilio: ${c.address}.`);
  if (c.postalCode) parts.push(`CP: ${c.postalCode}.`);
  return NextResponse.json({ answer: parts.join(" "), actions: [action] });
}

function executeSinglePriceEdit(params: PreModelIntentParams): NextResponse | null {
  // Owner → fall through to model (Slow Path). Returning null signals the
  // dispatcher not to handle this turn so the supervisor LLM can execute it.
  if (params.actorRole === "owner") {
    return null;
  }
  // Employee → warm reject canónico.
  const refusal = buildEmployeeRefusal("edit_product");
  logUnauthorizedAccess({
    attemptedAction: "edit_product",
    actorRole: params.actorRole,
    endpoint: "/api/business-assistant [dispatcher price-edit gate]",
    businessId: params.businessId,
    actorEmployeeId: params.actorEmployeeId ?? undefined,
  });
  return NextResponse.json({ answer: refusal.answer });
}

function executeMultiPriceEdit(intent: MultiPriceEditIntent): NextResponse {
  const summary = intent.edits.map((e) => `${e.productName} → $${e.value}`).join("\n");

  // Partial-match warning: some product names in the input weren't in the catalog.
  // Report them so the owner sees "fideos: no encontré" instead of silent omission.
  const unknownNote =
    intent.unknownFragments.length > 0
      ? `\n⚠ No encontré en el catálogo: ${intent.unknownFragments.join(", ")}.`
      : "";

  if (intent.edits.length === 0) {
    // All products were unknown — tell user nothing was recognized.
    return NextResponse.json({
      answer:
        `No encontré ningún producto del catálogo en tu mensaje (${intent.unknownFragments.join(", ")}). ` +
        "Revisá los nombres e intentá de nuevo.",
    });
  }

  const title = `¿Actualizar ${intent.edits.length === 1 ? "1 precio" : `${intent.edits.length} precios`}?\n${summary}${unknownNote}`;
  return NextResponse.json({
    answer: title,
    confirmationRequest: {
      id: crypto.randomUUID(),
      severity: "warning",
      title: "Confirmar actualización de precios",
      message: title,
      confirmLabel: "Confirmar",
      cancelLabel: "Cancelar",
      action: { type: "multi_edit_product", edits: intent.edits },
    },
  });
}

function executePriceUpdateClarification(): NextResponse {
  return NextResponse.json({
    answer:
      "Entendí que querés actualizar precios pero no identifiqué los productos. " +
      "Probá de nuevo indicando nombres del catálogo, por ejemplo: " +
      '"el precio de las papas $50, peras $40".',
    inputHint: "Ej: el precio de las papas $50, peras $40",
  });
}

// sale_create_pending_customer — producto resuelto, cliente no identificado.
// Muestra chips con top-5 clientes recientes + "Consumidor Final" + "Cliente nuevo".
function executeSaleCreatePendingCustomer(
  intent: SaleCreatePendingCustomerIntent,
  params: PreModelIntentParams,
): NextResponse {
  const rbac = gateIntentByRole({
    intent: "register_sale",
    role: params.actorRole,
    businessId: params.businessId,
    actorEmployeeId: params.actorEmployeeId,
    trace: { add: () => {}, toJSON: () => null },
  });
  if (rbac) return rbac;

  const topCustomers = params.context.catalog.customers.slice(0, 5);
  const productLabel =
    intent.qty > 1 ? `${intent.qty} ${intent.productName}` : intent.productName;
  const customerNames = topCustomers.map((c) => c.name).join(", ");
  const answerText = customerNames
    ? `¿A quién fue la venta de ${productLabel}? Clientes: ${customerNames}.`
    : `¿A quién fue la venta de ${productLabel}?`;

  return NextResponse.json({
    answer: answerText,
    actions: [
      {
        type: "select_customer_for_sale",
        matchedProductId: intent.matchedProductId,
        productName: intent.productName,
        qty: intent.qty,
        unitPrice: intent.unitPrice,
        clients: topCustomers,
      },
    ],
    chipButtons: [
      ...topCustomers.map((c) => ({ label: c.name, value: `cliente:${c.id}` })),
      { label: "Consumidor Final", value: "cliente:consumidor_final" },
      { label: "Cliente nuevo", value: "accion:nuevo_cliente" },
    ],
  });
}

// executeExternalAgentCall extracted to ./execute-external-agent-call.ts
// to keep dispatch.ts under the 300-line limit.
