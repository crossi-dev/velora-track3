import "server-only";
// stock-tools-backend.ts — Shared backend port for all stock.* tools.
//
// Each tool factory receives this interface and destructures only what it needs.
// Splitting the port into its own module avoids circular imports between the
// three tool files (consultar, gestionar, transferir).

import type { ProductInfoEntry } from "@/app/api/business-assistant/_lib/types";

export interface StockToolsBackend {
  businessId: string;
  actorUserId: string;
  actorEmployeeId: string | null;
  /** Pre-loaded product directory for the current request (read path). */
  productDirectory: ProductInfoEntry[];
  locale: string;
  business: { name: string; currency: string };
  inventorySummary: { productLines: number; totalUnits: number; totalValue: number };
}
