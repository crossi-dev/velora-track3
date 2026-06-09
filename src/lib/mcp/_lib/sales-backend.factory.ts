// src/lib/mcp/_lib/sales-backend.factory.ts — SalesBackend selection via SALES_BACKEND env var.
//
// Mirrors catalog-backend.factory.ts exactly:
//   - Reads process.env.SALES_BACKEND at CALL TIME (not module-load) so tests and
//     feature flags can toggle without a module reload.
//   - Default is "velora" when unset / blank — safe for all existing deployments.
//   - Fail-loud on unknown values: a typo'd SALES_BACKEND must not silently fall back.
//
// Supported backends:
//   "velora"      (default) — VeloraSalesAdapter delegating to the existing handler functions.
//   "tiendanube"            — TiendanubeSalesAdapter for a connected Tiendanube (Nuvemshop) store.
//                            register_movement is not supported on TN (returns errResponse).
//                            register_sale → POST /orders; return_sale → POST /orders/{id}/cancel.
//                            Credentials via BusinessChannelCredential(provider="tiendanube").
//
// Adding a new backend:
//   1. Implement `src/lib/mcp/_lib/<name>-sales.adapter.ts` satisfying SalesBackend.
//   2. Add a branch below: case "<name>": return new YourAdapter().
//   3. Add the string to SUPPORTED_BACKENDS.
//
// MONEY PATH: VeloraSalesAdapter is a pure delegation layer. It calls the exact
// same handler functions (handleRegisterSale, handleRegisterMovement, handleReturnSale)
// that sales-tools.ts previously called directly — behavior is byte-for-byte identical.

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { SalesBackend, RegisterSaleInput, RegisterMovementInput, ReturnSaleInput } from "./sales-backend.port";
import { TiendanubeSalesAdapter } from "./tiendanube-sales.adapter";
import { handleRegisterSale, type RegisterSaleArgs } from "./sales-mutations";
import { handleRegisterMovement, type RegisterMovementArgs } from "./sales-mutations";
import { handleReturnSale, type ReturnSaleArgs } from "./return-sale-mutations";
import type { CashMovementType } from "@/domain/ports/cash-movement.repository.port";

// ── VeloraSalesAdapter ────────────────────────────────────────────────────────

/**
 * Velora concrete implementation of SalesBackend.
 *
 * Pure delegation: calls the existing handler functions unchanged.
 * No logic lives here — the adapter is a pass-through shim so that
 * sales-tools.ts can be decoupled from the Velora use-case layer.
 *
 * The `as unknown as CallToolResult` casts are justified: the handler return
 * types are structurally identical to CallToolResult at runtime. The only
 * difference is that CallToolResult includes the `[x: string]: unknown` index
 * signature (from the MCP spec's ResultSchema $loose mode) which the local
 * McpToolResponse type does not carry. The cast is safe — no extra properties
 * are read from the response beyond `content` and `isError`.
 */
class VeloraSalesAdapter implements SalesBackend {
  registerSale(input: RegisterSaleInput): Promise<CallToolResult> {
    const { businessId, ...args } = input;
    return handleRegisterSale(businessId, args as RegisterSaleArgs) as unknown as Promise<CallToolResult>;
  }

  registerMovement(input: RegisterMovementInput): Promise<CallToolResult> {
    const { businessId, ...args } = input;
    return handleRegisterMovement(businessId, {
      ...args,
      type: args.type as CashMovementType,
    } as RegisterMovementArgs) as unknown as Promise<CallToolResult>;
  }

  returnSale(input: ReturnSaleInput): Promise<CallToolResult> {
    const { businessId, ...args } = input;
    return handleReturnSale(businessId, args as ReturnSaleArgs) as unknown as Promise<CallToolResult>;
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

const SUPPORTED_BACKENDS = ["velora", "tiendanube"] as const;
type SupportedBackend = (typeof SUPPORTED_BACKENDS)[number];

/**
 * Returns a SalesBackend instance for the active backend.
 *
 * Resolution order (first non-blank wins):
 *   1. tenantOverride  — per-tenant slug from TenantToolConfig (null = not set)
 *   2. SALES_BACKEND   — global env var
 *   3. "velora"        — hard default
 *
 * Throws on any unrecognised value — fail-loud, not silent-fallback.
 * Existing no-arg callers are unaffected (tenantOverride defaults to undefined).
 */
export function createSalesBackend(tenantOverride?: string | null): SalesBackend {
  const raw = (tenantOverride ?? process.env.SALES_BACKEND ?? "").trim() || "velora";

  if (!(SUPPORTED_BACKENDS as readonly string[]).includes(raw)) {
    throw new Error(
      `Unknown SALES_BACKEND="${raw}". Supported backends: ${SUPPORTED_BACKENDS.join(", ")}.`,
    );
  }
  const backend = raw as SupportedBackend;

  switch (backend) {
    case "velora":
      return new VeloraSalesAdapter();

    case "tiendanube":
      return new TiendanubeSalesAdapter();

    default: {
      const _exhaustive: never = backend;
      void _exhaustive;
      throw new Error(
        `Unknown SALES_BACKEND="${backend}". Supported backends: ${SUPPORTED_BACKENDS.join(", ")}.`,
      );
    }
  }
}
