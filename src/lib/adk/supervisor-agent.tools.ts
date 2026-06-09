// supervisor-agent.tools.ts — Tool list builder + ToolContext type for the Supervisor.
// Extracted from supervisor-agent.ts to keep that file under the 300-line limit.
// Each tool is registered only when its specific context is provided to avoid
// stub tools that would make the Supervisor answer incorrectly (e.g. 'no hay stock').
// Also exports injectPatternCAccumulator — wires the shared accumulator array into
// every A2A tool context so createA2AAgentTool can push captured dataParts intents.

import {
  createBusinessQueryTool,
  createCallContadorAgentTool,
  createCallVentasAgentTool,
  createCallPaymentsAgentTool,
  createCallLogisticaAgentTool,
  createCallCommunicationsAgentTool,
  createCallCustomerAgentTool,
  createVentasReportesTool,
  createCallCajaAgentTool,
  createCallInventarioAgentTool,
} from "./tools";
import { buildGroundingTools } from "./grounding";
import type { BusinessQueryToolContext } from "./tools/business-query-tool";
import type { CallContadorAgentToolContext } from "./tools/call-contador-agent-tool";
import type { CallVentasAgentToolContext } from "./tools/call-ventas-agent-tool";
import type { CallPaymentsAgentToolContext } from "./tools/call-payments-agent-tool";
import type { CallLogisticaAgentToolContext } from "./tools/call-logistica-agent-tool";
import type { CallCommunicationsAgentToolContext } from "./tools/call-communications-agent-tool";
import type { CallCustomerAgentToolContext } from "./tools/call-customer-agent-tool";
import type { VentasReportesBackend } from "./tools/ventas-reportes-tool";
import type { CallCajaAgentToolContext } from "./tools/call-caja-agent-tool";
import type { CallInventarioAgentToolContext } from "./tools/call-inventario-agent-tool";

export interface ToolContext {
  /** When present, the business_query data tool is registered. */
  businessQuery?: BusinessQueryToolContext;
  /** When present, the call_contador_agent tool is registered. */
  callContador?: CallContadorAgentToolContext;
  /** When present, the call_ventas_agent tool is registered. */
  callVentas?: CallVentasAgentToolContext;
  /** When present, the call_payments_agent tool is registered. */
  callPayments?: CallPaymentsAgentToolContext;
  /** When present, the call_logistica_agent tool is registered. */
  callLogistica?: CallLogisticaAgentToolContext;
  /** When present, the call_communications_agent tool is registered. */
  callCommunications?: CallCommunicationsAgentToolContext;
  /** When present, the call_customer_agent tool is registered (Step 4 — 2026-05-28). */
  callCustomer?: CallCustomerAgentToolContext;
  /** When present, ventas.consultar_ventas is registered (date-filtered DB queries). */
  ventasReportes?: VentasReportesBackend;
  /** When present, the call_caja_agent tool is registered (Caja Agent — 2026-06-03). */
  callCaja?: CallCajaAgentToolContext;
  /** When present, the call_inventario_agent tool is registered. */
  callInventario?: CallInventarioAgentToolContext;
  // callEquipo + callMarketplace ENCAJONADOS 2026-05-25.
}

/**
 * Inject a shared Pattern C accumulator into every A2A tool context.
 * Returns an updated ToolContext where all A2A contexts carry capturedPatternCIntents.
 * Tools that don't emit dataParts (payments, caja, fiscal, logistica) are safe to
 * receive it — they simply never push, leaving the array unchanged.
 * Extracted from supervisor-agent.ts to keep that file under the 300-line limit.
 */
export function injectPatternCAccumulator(
  toolContext: ToolContext | undefined,
  capturedPatternCIntents: Array<{ intent: string; data: unknown; summary: string }>,
): ToolContext | undefined {
  if (!toolContext) return undefined;
  const inj = capturedPatternCIntents;
  return {
    ...toolContext,
    ...(toolContext.callVentas && { callVentas: { ...toolContext.callVentas, capturedPatternCIntents: inj } }),
    ...(toolContext.callCommunications && { callCommunications: { ...toolContext.callCommunications, capturedPatternCIntents: inj } }),
    ...(toolContext.callInventario && { callInventario: { ...toolContext.callInventario, capturedPatternCIntents: inj } }),
    ...(toolContext.callPayments && { callPayments: { ...toolContext.callPayments, capturedPatternCIntents: inj } }),
    ...(toolContext.callCaja && { callCaja: { ...toolContext.callCaja, capturedPatternCIntents: inj } }),
  };
}

/** Build the ADK tool list for a given supervisor request. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildSupervisorTools(toolContext: ToolContext | undefined, businessId: string | undefined): any[] {
  const contextTools = toolContext
    ? [
        ...(toolContext.businessQuery ? [createBusinessQueryTool(toolContext.businessQuery)] : []),
        ...(toolContext.callContador ? [createCallContadorAgentTool(toolContext.callContador)] : []),
        ...(toolContext.callVentas ? [createCallVentasAgentTool(toolContext.callVentas)] : []),
        ...(toolContext.callPayments ? [createCallPaymentsAgentTool(toolContext.callPayments)] : []),
        ...(toolContext.callLogistica ? [createCallLogisticaAgentTool(toolContext.callLogistica)] : []),
        ...(toolContext.callCommunications ? [createCallCommunicationsAgentTool(toolContext.callCommunications)] : []),
        ...(toolContext.callCustomer ? [createCallCustomerAgentTool(toolContext.callCustomer)] : []),
        ...(toolContext.ventasReportes ? [createVentasReportesTool(toolContext.ventasReportes)] : []),
        ...(toolContext.callCaja ? [createCallCajaAgentTool(toolContext.callCaja)] : []),
        // call_inventario_agent: always included when context is provided (no provider gate needed —
        // stock and catalog are core Velora features, not optional integrations).
        ...(toolContext.callInventario ? [createCallInventarioAgentTool(toolContext.callInventario)] : []),
        // callEquipo + callMarketplace ENCAJONADOS 2026-05-25.
      ]
    : [];
  // Grounding: Vertex AI Search product-search tool. Inert ([]) unless
  // USE_VERTEX_SEARCH=true — anchors answers in the per-tenant datastore.
  return [...contextTools, ...(businessId ? buildGroundingTools(businessId) : [])];
}
