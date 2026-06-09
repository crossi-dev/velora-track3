import "server-only";
// owner-assistant-catalog.ts — Catalog context summary for the Owner Assistant.
//
// Mirrors customer-agent-catalog.ts but includes supplier names + customer names
// so the model can distinguish "create new product" from "load stock for existing product"
// and can resolve supplier names in stock_load inputs.
//
// Source (verified HTTP 200 2026-05-29):
//   https://adk.dev/sessions/state/ — InstructionProvider pattern for per-request
//   context injection via callback closure.

import { prisma } from "@/lib/prisma";
import { cloudLog } from "@/lib/cloud-logger";

const PRODUCT_FETCH_LIMIT = 30;
const SUPPLIER_FETCH_LIMIT = 10;
const CUSTOMER_FETCH_LIMIT = 20;

/**
 * Fetches the business catalog (products + suppliers + customers) and builds
 * a compact summary for injection into the Owner Assistant system instruction.
 *
 * Products: "ProductName: $price (N en stock)"
 * Suppliers: listed after products so the model can resolve supplier names in
 * stock_load inputs.
 * Customers: listed last so register_sale can resolve customer names by exact match.
 *
 * Non-fatal: errors return a neutral placeholder so the agent still runs.
 *
 * @param businessId — Tenant scope for all queries.
 */
export async function buildOwnerCatalogSummary(businessId: string): Promise<string> {
  try {
    // Prisma regen blocked on Windows DLL lock — cast required at SDK boundary.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const prismaAny = prisma as any; // eslint-disable-line @typescript-eslint/no-explicit-any -- Prisma DLL lock
    const [products, suppliers, customers] = await Promise.all([
      prismaAny.product.findMany({
        where: { businessId },
        select: { name: true, price: true, quantity: true },
        orderBy: { name: "asc" },
        take: PRODUCT_FETCH_LIMIT + 1,
      }),
      prismaAny.supplier.findMany({
        where: { businessId },
        select: { name: true },
        orderBy: { name: "asc" },
        take: SUPPLIER_FETCH_LIMIT,
      }),
      prismaAny.customer.findMany({
        where: { businessId },
        select: { name: true },
        orderBy: { name: "asc" },
        take: CUSTOMER_FETCH_LIMIT,
      }),
    ]);

    const lines: string[] = [];

    if (!products.length) {
      lines.push("(catálogo vacío — aún no hay productos)");
    } else {
      const isTruncated = products.length > PRODUCT_FETCH_LIMIT;
      const visible = isTruncated ? products.slice(0, PRODUCT_FETCH_LIMIT) : products;
      lines.push("Productos existentes:");
      for (const p of visible) {
        lines.push(`  ${p.name}: $${Number(p.price)} (${p.quantity} en stock)`);
      }
      if (isTruncated) lines.push("  ... (catálogo truncado)");
    }

    if (suppliers.length > 0) {
      lines.push("Proveedores:");
      for (const s of suppliers) lines.push(`  ${s.name}`);
    }

    if (customers.length > 0) {
      lines.push("Clientes existentes:");
      for (const c of customers) lines.push(`  ${c.name}`);
    }

    return lines.join("\n");
  } catch (err) {
    cloudLog({
      severity: "WARNING",
      component: "OwnerAssistant",
      action: "OWNER_ASSISTANT_CATALOG_SUMMARY_ERROR",
      a2a_transfer: false,
      message: `Failed to build owner catalog summary: ${err instanceof Error ? err.message : String(err)}`,
      data: { businessId },
    });
    return "(catálogo no disponible)";
  }
}
