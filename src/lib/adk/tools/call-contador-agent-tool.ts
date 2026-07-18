import "server-only";
// ADK FunctionTool -- call_contador_agent
//
// Role-agent for Contador (accountant). Routes to the Fiscal/ARCA translator
// at /api/agents/fiscal/jsonrpc. Replaces the former call_fiscal_agent tool.

import { Type } from "@google/genai";
import type { Schema } from "@google/genai";
import { prisma } from "@/lib/prisma";
import { getMissingBusinessData } from "@/app/api/business-assistant/_lib/missing-business-data";
import { CONTADOR_AGENT_TIMEOUT_MS } from "@/lib/agent-timeouts";
import {
  createA2AAgentTool,
  createBriefMessage,
  type A2AAgentToolContext,
  type A2AAgentToolResult,
} from "./_shared/create-a2a-agent-tool";

export type CallContadorAgentToolContext = A2AAgentToolContext;

const CALL_CONTADOR_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    message: {
      type: Type.STRING,
      description:
        "El mensaje a enviar al agente Contador (ARCA/AFIP). Describir la consulta o accion requerida: emision de comprobantes, situacion impositiva, cumplimiento fiscal, etc.",
    },
  },
  required: ["message"],
};

async function contadorPreConditionGuard(
  _args: { message: string },
  ctx: CallContadorAgentToolContext,
): Promise<A2AAgentToolResult | null> {
  // Precondition guard: invoicing requires CUIT.
  const businessRow = await prisma.business.findUnique({
    where: { id: ctx.businessId },
    select: { postalCode: true, paymentProvider: true, alias: true, whatsappPhone: true, cuit: true },
  });
  const missing = getMissingBusinessData({
    postalCode: businessRow?.postalCode,
    paymentProvider: businessRow?.paymentProvider,
    alias: businessRow?.alias,
    whatsappPhone: businessRow?.whatsappPhone,
    cuit: businessRow?.cuit,
  });
  if (missing.invoicing.blocked) {
    return { text: null, success: false, error: missing.invoicing.ownerPrompt, missingData: true };
  }
  return null;
}

export async function buildContadorFullMessage(
  args: { message: string },
  ctx: CallContadorAgentToolContext,
): Promise<string> {
  const { message } = args;

  // F-6: enrich the message with customer fiscal data (ivaCondition + CUIT/taxId)
  // so the Fiscal Agent can correctly decide invoice type without guessing.
  // Strategy: look for customers whose name appears in the message (case-insensitive),
  // or whose taxId matches a CUIT-pattern found in the message.
  let customerFiscalSuffix = "";
  const cuitPattern = /\b(\d{2}-?\d{8}-?\d)\b/g;
  const rawCuitsInMessage = [...message.matchAll(cuitPattern)].map((m) =>
    m[1].replace(/-/g, ""),
  );

  // Load customers for this business that have fiscal data.
  const fiscalCustomers = await prisma.customer.findMany({
    where: {
      businessId: ctx.businessId,
      OR: [
        { taxId: { not: null } },
        { ivaCondition: { not: null } },
      ],
    },
    select: { name: true, taxId: true, ivaCondition: true },
    take: 50,
  });

  const msgLower = message.toLowerCase();

  // Escape regex special characters in the customer name so names like
  // "Garcia & Hnos." don't blow up the RegExp constructor.
  function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  // For each customer: check whole-word name match (anchored) OR exact CUIT match.
  // Names shorter than 4 characters are too ambiguous (e.g. "Ana" -> "Analiza",
  // "Sol" -> "resolucion") and are NEVER matched by name -- only by CUIT.
  const nameMatches = fiscalCustomers.filter((c) => {
    if (!c.name || c.name.length < 4) return false;
    // Word-boundary anchored -- the name must appear as a complete token.
    const re = new RegExp(`(?<![\\w\u00C0-\u024F])${escapeRegex(c.name.toLowerCase())}(?![\\w\u00C0-\u024F])`, "u");
    return re.test(msgLower);
  });

  const cuitMatches = fiscalCustomers.filter((c) => {
    if (!c.taxId) return false;
    return rawCuitsInMessage.includes(c.taxId.replace(/-/g, ""));
  });

  // Merge without duplicates (prefer CUIT-matched set for dedup key).
  const allMatches = [
    ...cuitMatches,
    ...nameMatches.filter(
      (n) => !cuitMatches.some((ci) => ci.taxId === n.taxId && ci.name === n.name),
    ),
  ];

  // If MORE THAN ONE customer matches, attach none -- ambiguous input.
  const matched = allMatches.length === 1 ? allMatches[0] : null;

  if (matched) {
    const ivaLine = matched.ivaCondition
      ? `Condicion IVA del cliente: ${matched.ivaCondition}`
      : "Condicion IVA del cliente: no registrada";
    const cuitLine = matched.taxId ? `CUIT del cliente: ${matched.taxId}` : null;
    customerFiscalSuffix =
      "\n[DATOS FISCALES DEL CLIENTE -- provistos por el sistema, no inventados]\n" +
      ivaLine +
      (cuitLine ? `\n${cuitLine}` : "");
  }

  // Wrap in structured brief envelope (GAP2 fix). The fiscal suffix is appended
  // to the objective so the Contador Agent sees it as context for the task.
  // businessId is handled by createBriefMessage via the businessId field.
  return createBriefMessage({
    businessId: ctx.businessId,
    objective: message + customerFiscalSuffix,
    outputFormat:
      "Resultado de la operacion fiscal: CAE + vencimiento si es factura electronica, o respuesta a la consulta impositiva. Sin inventar numeros de comprobante.",
    failureInstruction:
      "Si ARCA/AFIP no responde o el comprobante no se pudo emitir, reporta el error real del servicio. NUNCA inventes un CAE ni un numero de comprobante.",
  });
}

export function createCallContadorAgentTool(ctx: CallContadorAgentToolContext) {
  return createA2AAgentTool(
    {
      toolName: "call_contador_agent",
      // Source: Wiesinger et al. SS3.2 "description functions as LLM documentation -- precision matters"
      // https://www.kaggle.com/whitepaper-agents
      description:
        "Issues fiscal documents (factura electronica via ARCA/AFIP WSFE, internal comprobante PDF), handles ARCA WSAA token authentication, queries fiscal status per CUIT, and emits transaction receipts. " +
        "Use for any invoicing or comprobante request: factura, comprobante, ARCA, AFIP, situacion impositiva.",
      schema: CALL_CONTADOR_SCHEMA,
      timeoutMs: CONTADOR_AGENT_TIMEOUT_MS,
      callerIdentity: "supervisor",
      targetIdentity: "fiscal",
      agentPath: "/api/agents/fiscal/jsonrpc",
      logActionKey: "CONTADOR",
      agentDisplayName: "Contador Agent",
      includeCodeInA2AError: true,
      includeBusinessIdInFailLog: false,
      preConditionGuard: contadorPreConditionGuard,
      // F-6: customer fiscal enrichment (ivaCondition + CUIT) + GAP2 structured envelope.
      // ARCA real mode WSAA+WSFE dual SOAP round-trips can each take ~10 s;
      // cutting at 12 s caused the invoice to be emitted but the supervisor
      // never received confirmation -- floor ensures we keep meaningful runway.
      buildFullMessage: buildContadorFullMessage,
    },
    ctx,
  );
}
