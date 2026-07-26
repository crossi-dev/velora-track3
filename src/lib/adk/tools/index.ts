// ADK FunctionTool registry — re-exports all tool factories.
//
// Usage (in agent files):
//   import { createCheckStockTool, createRegisterSaleTool, ... } from "./tools";
//
// Each export is a factory function because tools capture request-scoped
// context (product catalog, customer list) via closure — no shared state.

export { createCheckStockTool } from "./check-stock-tool";
export type { CheckStockToolContext } from "./check-stock-tool";

export { createRegisterSaleTool } from "./register-sale-tool";
export type { RegisterSaleToolContext } from "./register-sale-tool";


export { createBusinessQueryTool } from "./business-query-tool";
export type { BusinessQueryToolContext } from "./business-query-tool";

export { createEscalateToOwnerTool } from "./escalate-to-owner-tool";
export type { EscalateToOwnerToolContext } from "./escalate-to-owner-tool";

export { createPurchaseRequestTool } from "./create-purchase-request-tool";

export { createCallContadorAgentTool } from "./call-contador-agent-tool";
export type { CallContadorAgentToolContext } from "./call-contador-agent-tool";

export { createCallVentasAgentTool } from "./call-ventas-agent-tool";
export type { CallVentasAgentToolContext } from "./call-ventas-agent-tool";

export { createCallPaymentsAgentTool } from "./call-payments-agent-tool";
export type { CallPaymentsAgentToolContext } from "./call-payments-agent-tool";

export { createCallLogisticaAgentTool } from "./call-logistica-agent-tool";
export type { CallLogisticaAgentToolContext } from "./call-logistica-agent-tool";

export { createCallCommunicationsAgentTool } from "./call-communications-agent-tool";
export type { CallCommunicationsAgentToolContext } from "./call-communications-agent-tool";

export { createCallCustomerAgentTool } from "./call-customer-agent-tool";
export type { CallCustomerAgentToolContext } from "./call-customer-agent-tool";

export { createVentasReportesTool } from "./ventas-reportes-tool";
export type { VentasReportesBackend } from "./ventas-reportes-tool";

export {
  createConsultarStockTool,
  createGestionarStockTool,
  createTransferirEntreSucursalesTool,
} from "./stock-tools";
export type { StockToolsBackend } from "./stock-tools";

export {
  createGestionarProductoTool,
  createConsultarPrecioTool,
} from "./catalogo-tools";
export type { CatalogoToolsBackend } from "./catalogo-tools";

export { createPreciosTipoClienteTool } from "./catalogo-precios-tipo-cliente-tool";
export type { CatalogoPrecionTipoClienteBackend } from "./catalogo-precios-tipo-cliente-tool";

export { createCallCajaAgentTool } from "./call-caja-agent-tool";
export type { CallCajaAgentToolContext } from "./call-caja-agent-tool";

export {
  createCicloCajaTool,
  createConsultarSaldoTool,
  createRegistrarMovimientoTool,
} from "./caja-tools";
export type { CajaToolsBackend } from "./caja-tools";
export { createCallInventarioAgentTool } from "./call-inventario-agent-tool";
export type { CallInventarioAgentToolContext } from "./call-inventario-agent-tool";
