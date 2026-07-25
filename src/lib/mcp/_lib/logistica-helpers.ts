// src/lib/mcp/_lib/logistica-helpers.ts — Shared helpers for logistica-tools.ts.
//
// Extracted here to keep logistica-tools.ts under the 300-line file limit.
// Not exported from the MCP public surface — used only by logistica-tools.ts.
//
// Package weight computation lives in logistica-package-profile.ts (extracted
// to keep this file under the 300-line contract).
// registerPackageProfileTool accepts an optional LogisticaBackend so the
// get_package_profile tool routes through the backend seam (like the other three tools).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { LogisticaBackend } from "./logistica-backend.port";
import { prisma } from "@/lib/prisma";
import { COURIER_REGISTRY } from "@/app/api/agents/logistica/jsonrpc/_lib/courier-registry";
import type { CourierEntry } from "@/app/api/agents/logistica/jsonrpc/_lib/courier-registry";

// ── Shared error response builder ─────────────────────────────────────────────

export function errResponse(message: string) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}

// ── Active courier resolution ─────────────────────────────────────────────────

/**
 * Resolves which couriers are active for a given business.
 * Mirrors the logic in rate-comparison-tool.ts exactly.
 *
 * Active when ANY of:
 *   - Registry `active:true` AND a CourierCredential row exists for (businessId, provider), OR
 *   - Andreani AND ANDREANI_CLIENT_ID env var is present (global fallback), OR
 *   - PedidosYa AND a BusinessChannelCredential(provider:"pedidosya") row exists
 *     (BYOA — PedidosYa creds live in BusinessChannelCredential, NOT CourierCredential),
 *     OR PEDIDOSYA_API_TOKEN env fallback is set, OR
 *   - Matches Business.courierPreference (tenant override).
 *
 * The PedidosYa gate keeps it OUT of the quote fan-out for businesses that have
 * not connected an account — it is only added when a credential is present.
 */
export async function resolveActiveCouriers(businessId: string): Promise<CourierEntry[]> {
  const [credentialRows, businessRow, pedidosyaChannel] = await Promise.all([
    prisma.courierCredential.findMany({
      where: { businessId },
      select: { provider: true },
    }),
    prisma.business.findUnique({
      where: { id: businessId },
      select: { courierPreference: true },
    }),
    prisma.businessChannelCredential.findUnique({
      where: { businessId_provider: { businessId, provider: "pedidosya" } },
      select: { id: true },
    }),
  ]);

  const connectedSlugs = new Set(credentialRows.map((c) => c.provider));
  const tenantPreference = businessRow?.courierPreference?.trim().toLowerCase() ?? null;
  const andreaniGlobalFallback = Boolean(process.env.ANDREANI_CLIENT_ID);
  const pedidosyaConnected =
    Boolean(pedidosyaChannel) || (process.env.PEDIDOSYA_API_TOKEN ?? "").trim().length > 0;

  return COURIER_REGISTRY.filter((c) => {
    if (tenantPreference && c.name === tenantPreference) return true;
    if (!c.active) return false;
    if (connectedSlugs.has(c.name)) return true;
    if (c.name === "andreani" && andreaniGlobalFallback) return true;
    if (c.name === "pedidosya") return pedidosyaConnected;
    return false;
  });
}

// ── Result parsing ────────────────────────────────────────────────────────────

export interface CourierOption {
  provider: string;
  service: string;
  serviceLabel: string;
  priceARS: number;
  estimatedDays: number;
}

/**
 * Extracts the text payload from a JsonRpcResponse result.
 * Returns null when the response carries an error body.
 */
export function extractResultText(rpcResponse: unknown): string | null {
  const resp = rpcResponse as Record<string, unknown>;
  if ("error" in resp) return null;
  const result = resp.result as { parts?: Array<{ text?: string }> } | undefined;
  return result?.parts?.[0]?.text ?? null;
}

export function parseOptions(text: string, providerName: string): CourierOption[] {
  try {
    const jsonStart = text.indexOf("{");
    if (jsonStart === -1) return [];
    const parsed = JSON.parse(text.slice(jsonStart)) as Record<string, unknown>;
    const items: Record<string, unknown>[] = Array.isArray(parsed.options)
      ? (parsed.options as Record<string, unknown>[])
      : Array.isArray(parsed.services)
        ? (parsed.services as Record<string, unknown>[])
        : [];
    return items
      .map((item) => {
        const priceARS =
          typeof item.priceARS === "number"
            ? item.priceARS
            : typeof item.price === "number"
              ? item.price
              : null;
        if (priceARS === null) return null;
        return {
          provider: providerName,
          service: typeof item.service === "string" ? item.service : providerName,
          serviceLabel:
            typeof item.serviceLabel === "string"
              ? item.serviceLabel
              : typeof item.service === "string"
                ? item.service
                : providerName,
          priceARS,
          estimatedDays: typeof item.estimatedDays === "number" ? item.estimatedDays : 0,
        } satisfies CourierOption;
      })
      .filter((o): o is CourierOption => o !== null);
  } catch {
    return [];
  }
}

// ── Shared quote fan-out ───────────────────────────────────────────────────────

export interface QuoteShippingOptionsInput {
  originPostalCode: string;
  destinationPostalCode: string;
  weightGrams: number;
  declaredValue?: number;
}

export interface QuoteShippingOptionsResult {
  options: CourierOption[];
  cheapestPriceARS: number | null;
  /** Number of couriers active for this business, before fan-out. 0 means nothing to quote. */
  activeCourierCount: number;
  partialFailures?: Array<{ courier: string; reason: string }>;
}

/**
 * Fans out a shipping quote across every active courier for the business and
 * returns options sorted by price ascending. Shared by `quote_shipping`
 * (logistica-tools.ts) and `open_shipment_prep` (shipment-prep-render.ts) so
 * both tools quote shipping the exact same way.
 */
export async function quoteShippingOptions(
  backend: LogisticaBackend,
  businessId: string,
  input: QuoteShippingOptionsInput,
): Promise<QuoteShippingOptionsResult> {
  const { activeCouriers } = await backend.resolveActiveCouriers({
    tenantId: businessId,
    originPostalCode: input.originPostalCode,
    destinationPostalCode: input.destinationPostalCode,
    weightGrams: input.weightGrams,
    declaredValue: input.declaredValue,
  });

  if (activeCouriers.length === 0) {
    return { options: [], cheapestPriceARS: null, activeCourierCount: 0 };
  }

  const settled = await Promise.allSettled(
    activeCouriers.map(async (courier) => {
      const adapter = courier.getAdapter();
      const rpcResponse = await adapter.quote(
        {
          originPostalCode: input.originPostalCode,
          destinationPostalCode: input.destinationPostalCode,
          weightGrams: input.weightGrams,
          declaredValue: input.declaredValue ?? 0,
        },
        businessId,
      );
      const text = extractResultText(rpcResponse) ?? "";
      return { courier: courier.name, text };
    }),
  );

  const allOptions: CourierOption[] = [];
  const partialFailures: Array<{ courier: string; reason: string }> = [];
  for (const [i, r] of settled.entries()) {
    if (r.status === "fulfilled") {
      allOptions.push(...parseOptions(r.value.text, r.value.courier));
    } else {
      // Collect failures so the agent knows a cheaper option may have been skipped.
      const reason = r.reason instanceof Error ? r.reason.message : String(r.reason);
      partialFailures.push({ courier: activeCouriers[i]?.name ?? "unknown", reason });
    }
  }

  allOptions.sort((a, b) => a.priceARS - b.priceARS);

  return {
    options: allOptions,
    cheapestPriceARS: allOptions.length > 0 ? allOptions[0].priceARS : null,
    activeCourierCount: activeCouriers.length,
    ...(partialFailures.length > 0 ? { partialFailures } : {}),
  };
}

// ── OCA validation ────────────────────────────────────────────────────────────

/**
 * Guards OCA-required fields before calling the adapter.
 * Returns an error message string when a required field is missing, null otherwise.
 * Mirrors the ADK required-field checks in handle-logistica-rpc.ts.
 */
export function checkOcaRequiredFields(
  customerAddressNumber: string | undefined,
  customerProvince: string | undefined,
): string | null {
  if (!customerAddressNumber) {
    return "OCA requires 'customerAddressNumber' — please provide the street number.";
  }
  if (!customerProvince) {
    return "OCA requires 'customerProvince' — please provide the recipient province.";
  }
  return null;
}

// ── get_package_profile tool registration ────────────────────────────────────

/**
 * Registers the get_package_profile tool on the server.
 * Extracted here to keep logistica-tools.ts under the 300-line contract.
 * Routes through LogisticaBackend.getPackageProfile for the actual weight computation.
 */
export function registerPackageProfileTool(
  server: McpServer,
  errResponseFn: (msg: string) => { content: Array<{ type: "text"; text: string }>; isError: boolean },
  businessId: string,
  backend: LogisticaBackend,
): void {
  server.registerTool(
    "get_package_profile",
    {
      title: "Get package profile",
      description:
        "Use this before `quote_shipping` to compute the total package weight from a sale or product list. " +
        "Computes the shipment weight and item breakdown for a package. " +
        "Accepts a saleId, a list of productIds, or an explicit weightGramsOverride. " +
        "Uses Product.weightGrams when available; falls back to 500 g/item for products " +
        "without a weight. hasRealWeightData is true only when ALL items had real data. " +
        "Returns { weightGrams, hasRealWeightData, itemCount, breakdown } — " +
        "breakdown lists each productId with its quantity and computed weightGrams. " +
        "When no inputs are provided returns a single-item 500 g default (not an error).",
      inputSchema: {
        saleId: z
          .string()
          .optional()
          .describe(
            "Velora Sale ID. When provided, weight is derived from SaleItem → Product rows. " +
            "Takes priority over productIds.",
          ),
        productIds: z
          .array(z.string())
          .optional()
          .describe(
            "Array of Velora Product IDs. For multi-quantity orders prefer saleId — " +
            "the productIds path assumes qty=1 per id. Used when saleId is not available.",
          ),
        weightGramsOverride: z
          .number()
          .positive()
          .optional()
          .describe(
            "Explicit total weight in grams. When set, skips all DB lookups and " +
            "returns hasRealWeightData: true. Takes priority over saleId and productIds.",
          ),
      },
      // Spec ToolAnnotations: https://modelcontextprotocol.io/specification/2025-06-18/schema
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (args) => {
      try {
        const profile = await backend.getPackageProfile({
          tenantId: businessId,
          saleId: args.saleId,
          productIds: args.productIds,
          weightGramsOverride: args.weightGramsOverride,
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(profile) }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        return errResponseFn(`Error computing package profile: ${message}`);
      }
    },
  );
}
