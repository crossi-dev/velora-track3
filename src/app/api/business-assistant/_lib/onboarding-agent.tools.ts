// Onboarding LLM-front-door — FunctionTool handlers (tools 1 & 2).
//
// Follows the ADK FunctionTool handler pattern (typed input → async result):
// https://google.github.io/adk-docs/tools/function-tools/
//
// Tools 3 & 4 (connect_payment_method, connect_shipping_provider) live in
// onboarding-agent.tools.payment-shipping.ts to stay under the 250-line limit.
//
// Camino B — conservative: covers currently_due fields only. JIT fields
// (postal code, alias, CUIT) stay in the existing deterministic stages.

import { cloudLog } from "@/lib/cloud-logger";
import { executeBusinessSetupActions } from "@/app/api/supervisor/_lib/business-setup-actions";
import {
  createOnboardingProduct,
  clearPendingStockProduct,
} from "@/app/api/supervisor/_lib/onboarding-product-actions";

// ── Shared types re-exported for the runner and sibling tool file ─────────────

export interface ToolContext {
  businessId: string;
  actorUserId: string;
  /** Idempotency seed derived from inboundEventId + businessId + actorUserId. */
  idempotencySeed: string;
}

export interface ToolResult {
  /** true = executed successfully (or already idempotent). */
  ok: boolean;
  /** Human-readable confirmation for the agent answer. null on failure. */
  confirmation: string | null;
  /** Error detail for logs/telemetry. null on success. */
  error: string | null;
}

// ── Tool 1: save_business_name ────────────────────────────────────────────────
//
// Persists Business.name via the businessName field handler in
// business-setup-actions.ts (line 119). Same code path as the fast-path T1.
//
// ADK FunctionTool declaration name: "save_business_name"

export interface SaveBusinessNameArgs {
  /** Non-empty display name chosen by the owner. */
  name: string;
}

export async function saveBusinessName(
  args: SaveBusinessNameArgs,
  ctx: ToolContext,
): Promise<ToolResult> {
  const { name } = args;
  if (typeof name !== "string" || name.trim().length === 0) {
    return { ok: false, confirmation: null, error: "save_business_name: name must be a non-empty string" };
  }
  const trimmed = name.trim();
  const result = await executeBusinessSetupActions(
    [{ intent: "update_business_setup", data: { field: "businessName", value: trimmed }, summary: `Nombre: ${trimmed}` }],
    ctx.businessId,
    ctx.actorUserId,
    ctx.idempotencySeed,
  );
  if (result.errors.length > 0) {
    cloudLog({ severity: "WARNING", component: "OnboardingTools", action: "TOOL_SAVE_BUSINESS_NAME_FAILED", a2a_transfer: false, message: result.errors.join("; "), businessId: ctx.businessId });
    return { ok: false, confirmation: null, error: result.errors.join("; ") };
  }
  return { ok: true, confirmation: `Nombre del negocio guardado: ${trimmed}`, error: null };
}

// ── Tool 2: import_catalog ────────────────────────────────────────────────────
//
// Four sub-paths:
//   "skip"  → sets skippedCatalog=true via update_business_setup.
//   "paste" → bulk-creates products via createOnboardingProduct (same as T5 bulk).
//   "file"  → returns clientAction "open_file_picker" (client opens upload UI).
//   "photo" → returns clientAction "open_photo_picker" (client opens camera).
//
// For "file" / "photo" the tool signals the client; actual import is
// client-side. catalog_ready is NOT flipped yet — the upload resolution does it.
//
// ADK FunctionTool declaration name: "import_catalog"

export type CatalogMethod = "file" | "photo" | "paste" | "skip";

export interface CatalogItem {
  name: string;
  price: number;
}

export interface ImportCatalogArgs {
  method: CatalogMethod;
  /** Required when method is "paste". At least one item. */
  items?: CatalogItem[];
}

export interface ImportCatalogResult extends ToolResult {
  clientAction?: "open_file_picker" | "open_photo_picker";
  /** True when catalog_ready should flip immediately (skip / successful paste ≥1). */
  catalogReadyNow: boolean;
  /**
   * Number of products successfully created (paste path only; 0 for skip/file/photo).
   * Exposed so dispatchTool can report the real count to the user on partial success.
   */
  successCount: number;
  /** Total products attempted (paste path only; 0 for skip/file/photo). */
  totalCount: number;
}

export async function importCatalog(
  args: ImportCatalogArgs,
  ctx: ToolContext,
): Promise<ImportCatalogResult> {
  const { method, items = [] } = args;

  if (method === "skip") {
    const result = await executeBusinessSetupActions(
      [{ intent: "update_business_setup", data: { field: "skippedCatalog", value: true }, summary: "Catálogo diferido" }],
      ctx.businessId,
      ctx.actorUserId,
      ctx.idempotencySeed,
    );
    if (result.errors.length > 0) {
      cloudLog({ severity: "WARNING", component: "OnboardingTools", action: "TOOL_IMPORT_CATALOG_SKIP_FAILED", a2a_transfer: false, message: result.errors.join("; "), businessId: ctx.businessId });
      return { ok: false, confirmation: null, error: result.errors.join("; "), catalogReadyNow: false, successCount: 0, totalCount: 0 };
    }
    return { ok: true, confirmation: "Catálogo diferido.", error: null, catalogReadyNow: true, successCount: 0, totalCount: 0 };
  }

  if (method === "file") {
    return { ok: true, confirmation: null, error: null, clientAction: "open_file_picker", catalogReadyNow: false, successCount: 0, totalCount: 0 };
  }

  if (method === "photo") {
    return { ok: true, confirmation: null, error: null, clientAction: "open_photo_picker", catalogReadyNow: false, successCount: 0, totalCount: 0 };
  }

  // method === "paste": bulk-create products from pasted list.
  if (!Array.isArray(items) || items.length === 0) {
    return { ok: false, confirmation: null, error: "import_catalog paste: items must be a non-empty array", catalogReadyNow: false, successCount: 0, totalCount: 0 };
  }
  const totalCount = items.length;
  let successCount = 0;
  for (let idx = 0; idx < items.length; idx++) {
    const item = items[idx];
    if (!item?.name?.trim() || typeof item.price !== "number") { continue; }
    const itemSeed = `${ctx.idempotencySeed}|catalog|${idx}|${item.name}|${item.price}`;
    const created = await createOnboardingProduct({
      businessId: ctx.businessId,
      actorUserId: ctx.actorUserId,
      idempotencySeed: itemSeed,
      name: item.name.trim(),
      price: item.price,
    });
    if (created) { successCount++; }
  }
  // Clear lingering pendingStockProductId so the owner is not dropped into the
  // per-product stock loop after bulk paste.
  await clearPendingStockProduct({
    businessId: ctx.businessId,
    actorUserId: ctx.actorUserId,
    idempotencySeed: `${ctx.idempotencySeed}|catalog|clear-pending`,
  });
  // catalogReadyNow: any success counts (≥1 created). Design §7.1.
  const catalogReadyNow = successCount >= 1;
  if (!catalogReadyNow) {
    cloudLog({ severity: "WARNING", component: "OnboardingTools", action: "TOOL_IMPORT_CATALOG_ZERO_CREATED", a2a_transfer: false, message: `0/${totalCount} paste items created`, businessId: ctx.businessId });
    return {
      ok: false,
      confirmation: null,
      error: `Ningún producto se pudo crear (${totalCount} intentados)`,
      catalogReadyNow: false,
      successCount: 0,
      totalCount,
    };
  }
  if (successCount < totalCount) {
    cloudLog({ severity: "WARNING", component: "OnboardingTools", action: "TOOL_IMPORT_CATALOG_PARTIAL", a2a_transfer: false, message: `${successCount}/${totalCount} paste items created`, businessId: ctx.businessId });
  }
  return {
    ok: true,
    confirmation: successCount < totalCount
      ? `Cargué ${successCount} de ${totalCount} — ${totalCount - successCount} fallaron.`
      : `${successCount} producto(s) cargados con stock 0.`,
    error: successCount < totalCount ? `${totalCount - successCount} productos no se pudieron crear` : null,
    catalogReadyNow: true,
    successCount,
    totalCount,
  };
}
