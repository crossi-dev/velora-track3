import "server-only";
// stock-tools.ts — Barrel re-export for all stock.* tools.
//
// Implementations are split across:
//   stock-tools-backend.ts  — shared StockToolsBackend port
//   stock-consultar-tool.ts — stock.consultar_stock (read-only, low-stock filter)
//   stock-gestionar-tool.ts — stock.gestionar_stock (load + adjust + stocktake)
//   stock-transferir-tool.ts — stock.transferir_entre_sucursales (multi-location stub)

export type { StockToolsBackend } from "./stock-tools-backend";
export { createConsultarStockTool } from "./stock-consultar-tool";
export { createGestionarStockTool } from "./stock-gestionar-tool";
export { createTransferirEntreSucursalesTool } from "./stock-transferir-tool";
