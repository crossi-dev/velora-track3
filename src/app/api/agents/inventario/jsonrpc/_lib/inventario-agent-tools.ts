// inventario-agent-tools.ts — Tool assembly for the Inventario ADK agent.
//
// Wires the pre-existing stock.* and catalogo.* tool factories into the agent.
// No new tool implementations live here — all tool logic is in:
//   src/lib/adk/tools/stock-consultar-tool.ts  (read — autonomous)
//   src/lib/adk/tools/stock-gestionar-tool.ts  (HITL mutation)
//   src/lib/adk/tools/stock-transferir-tool.ts (HITL mutation)
//   src/lib/adk/tools/catalogo-tools.ts        (read + HITL mutation)
//
// Backend shape combines StockToolsBackend + CatalogoToolsBackend into a single
// InventarioToolsBackend so the RPC handler can build both with one prefetch.

import type { BaseTool } from "@google/adk";
import {
  createConsultarStockTool,
  createGestionarStockTool,
  createTransferirEntreSucursalesTool,
  type StockToolsBackend,
} from "@/lib/adk/tools/stock-tools";
import {
  createGestionarProductoTool,
  createConsultarPrecioTool,
  type CatalogoToolsBackend,
} from "@/lib/adk/tools/catalogo-tools";

// ── Combined backend port ─────────────────────────────────────────────────────
// Inventario owns both stock and catalog, so the agent gets both backends
// composed into one object passed down from the RPC handler.

export interface InventarioToolsBackend extends StockToolsBackend, CatalogoToolsBackend {
  // StockToolsBackend fields:
  //   businessId, actorUserId, actorEmployeeId, productDirectory, locale,
  //   business: { name, currency }, inventorySummary: { productLines, totalUnits, totalValue }
  // CatalogoToolsBackend fields:
  //   businessId, productDirectory, currency, locale
  // Note: businessId, productDirectory, locale are shared — the merged interface
  // picks them once. currency lives on CatalogoToolsBackend; business.currency
  // is the same value via StockToolsBackend.business.currency.
}

// ── Tool builder ──────────────────────────────────────────────────────────────

export function buildInventarioTools(backend: InventarioToolsBackend): BaseTool[] {
  return [
    // ── Read tools (autonomous — no HITL) ──────────────────────────────────
    // stock.consultar_stock: filter=all|low_stock|single
    createConsultarStockTool(backend),
    // catalogo.consultar_precio: price or stock lookup by product name
    createConsultarPrecioTool(backend),
    // ── Mutation tools (HITL — propose first, execute on confirmation) ──────
    // stock.gestionar_stock: action=load|adjust|stocktake
    // stocktake is the "physical count" hard gate per Square inventory API docs.
    createGestionarStockTool(backend),
    // stock.transferir_entre_sucursales: inter-location transfer (requires multi-location
    // migration — returns MULTI_LOCATION_REQUIRED guard until that migration lands)
    createTransferirEntreSucursalesTool(backend),
    // catalogo.gestionar_producto: create|edit|delete|bulk_price
    createGestionarProductoTool(backend),
  ];
}
