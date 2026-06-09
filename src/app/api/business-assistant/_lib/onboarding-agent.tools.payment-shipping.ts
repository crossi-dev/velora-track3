// Onboarding LLM-front-door — FunctionTool handlers (tools 3 & 4).
//
// Follows the ADK FunctionTool handler pattern (typed input → async result):
// https://google.github.io/adk-docs/tools/function-tools/
//
// Tools 1 & 2 (save_business_name, import_catalog) live in
// onboarding-agent.tools.ts.
//
// Camino B — conservative: covers currently_due fields only.

import { cloudLog } from "@/lib/cloud-logger";
import { encryptCredential } from "@/lib/credential-cipher";
import { executeBusinessSetupActions } from "@/app/api/supervisor/_lib/business-setup-actions";
import type { PaymentMethod, ShippingProvider } from "./onboarding-session-state";
import type { ToolContext, ToolResult } from "./onboarding-agent.tools";

// ── Tool 3: connect_payment_method ────────────────────────────────────────────
//
// Saves Business.paymentMethods JSON via the paymentMethods field handler
// (business-setup-actions.ts line 149). Same code path as the fast-path T3.
// If "mercadopago" is included, signals clientAction "open_mp_oauth".
// If "transferencia" is included, flags needsTransferAlias so the LLM
// knows to prompt JIT via the existing alias stage (eventually_due — NOT here).
//
// ADK FunctionTool declaration name: "connect_payment_method"

export interface ConnectPaymentMethodArgs {
  /** One or more payment methods chosen by the owner. */
  methods: PaymentMethod[];
}

export interface ConnectPaymentMethodResult extends ToolResult {
  clientAction?: "open_mp_oauth";
  /** True when owner chose "transferencia" — signals JIT alias collection. */
  needsTransferAlias: boolean;
}

// Maps session-state PaymentMethod values to the legacy string labels that
// business-setup-actions.ts normalizes (Mercado Pago / Transferencia / Efectivo).
const METHOD_LABELS: Record<PaymentMethod, string> = {
  mercadopago: "Mercado Pago",
  transferencia: "Transferencia",
  efectivo: "Efectivo",
};

export async function connectPaymentMethod(
  args: ConnectPaymentMethodArgs,
  ctx: ToolContext,
): Promise<ConnectPaymentMethodResult> {
  const { methods } = args;
  if (!Array.isArray(methods) || methods.length === 0) {
    return { ok: false, confirmation: null, error: "connect_payment_method: methods must have at least one entry", needsTransferAlias: false };
  }
  const labeledMethods = methods.map((m) => METHOD_LABELS[m] ?? m);
  const result = await executeBusinessSetupActions(
    [{ intent: "update_business_setup", data: { field: "paymentMethods", value: labeledMethods }, summary: `Métodos: ${labeledMethods.join(", ")}` }],
    ctx.businessId,
    ctx.actorUserId,
    ctx.idempotencySeed,
  );
  if (result.errors.length > 0) {
    cloudLog({ severity: "WARNING", component: "OnboardingTools", action: "TOOL_CONNECT_PAYMENT_FAILED", a2a_transfer: false, message: result.errors.join("; "), businessId: ctx.businessId });
    return { ok: false, confirmation: null, error: result.errors.join("; "), needsTransferAlias: false };
  }
  const hasMp = methods.includes("mercadopago");
  const hasTransfer = methods.includes("transferencia");
  return {
    ok: true,
    confirmation: `Métodos de pago guardados: ${labeledMethods.join(", ")}.`,
    error: null,
    ...(hasMp && !hasTransfer ? { clientAction: "open_mp_oauth" as const } : {}),
    needsTransferAlias: hasTransfer,
  };
}

// ── Tool 4: connect_shipping_provider ─────────────────────────────────────────
//
// Two DB-write paths:
//   "andreani" + token → encryptCredential → save andreaniApiToken via byoa handler.
//   "none" → set courierPreference="ninguno" via update_business_setup.
// Two client-action paths:
//   "andreani" (no token) → open_settings → panel "logistica.andreani".
//   "oca" → open_settings → panel "logistica.oca".
//   "correo" → open_settings → panel "logistica.correo".
//
// ADK FunctionTool declaration name: "connect_shipping_provider"

export interface ConnectShippingProviderArgs {
  provider: ShippingProvider;
  /** Plaintext Andreani API token. Required when provider is "andreani". */
  token?: string;
}

export interface ConnectShippingProviderResult extends ToolResult {
  clientAction?: "open_settings";
  clientActionParams?: { panel: "logistica.andreani" | "logistica.oca" | "logistica.correo" };
}

export async function connectShippingProvider(
  args: ConnectShippingProviderArgs,
  ctx: ToolContext,
): Promise<ConnectShippingProviderResult> {
  const { provider, token } = args;

  if (provider === "none") {
    const result = await executeBusinessSetupActions(
      [{ intent: "update_business_setup", data: { field: "courierPreference", value: "ninguno" }, summary: "Sin envíos" }],
      ctx.businessId,
      ctx.actorUserId,
      ctx.idempotencySeed,
    );
    if (result.errors.length > 0) {
      cloudLog({ severity: "WARNING", component: "OnboardingTools", action: "TOOL_CONNECT_SHIPPING_NONE_FAILED", a2a_transfer: false, message: result.errors.join("; "), businessId: ctx.businessId });
      return { ok: false, confirmation: null, error: result.errors.join("; ") };
    }
    return { ok: true, confirmation: "Sin envíos registrado.", error: null };
  }

  if (provider === "oca") {
    return { ok: true, confirmation: null, error: null, clientAction: "open_settings", clientActionParams: { panel: "logistica.oca" } };
  }

  if (provider === "correo") {
    return { ok: true, confirmation: null, error: null, clientAction: "open_settings", clientActionParams: { panel: "logistica.correo" } };
  }

  // provider === "andreani": save token if provided; open panel if token absent.
  if (!token || token.trim().length === 0) {
    return { ok: true, confirmation: null, error: null, clientAction: "open_settings", clientActionParams: { panel: "logistica.andreani" } };
  }

  let encryptedToken: string;
  try {
    encryptedToken = encryptCredential(token.trim());
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    cloudLog({ severity: "ERROR", component: "OnboardingTools", action: "TOOL_CONNECT_SHIPPING_ENCRYPT_FAILED", a2a_transfer: false, message: msg, businessId: ctx.businessId });
    return { ok: false, confirmation: null, error: `encryptCredential failed: ${msg}` };
  }

  const result = await executeBusinessSetupActions(
    [{ intent: "update_business_setup", data: { field: "andreaniApiToken", value: encryptedToken }, summary: "Token Andreani guardado" }],
    ctx.businessId,
    ctx.actorUserId,
    ctx.idempotencySeed,
  );
  if (result.errors.length > 0) {
    cloudLog({ severity: "WARNING", component: "OnboardingTools", action: "TOOL_CONNECT_SHIPPING_ANDREANI_FAILED", a2a_transfer: false, message: result.errors.join("; "), businessId: ctx.businessId });
    return { ok: false, confirmation: null, error: result.errors.join("; ") };
  }
  return { ok: true, confirmation: "Credenciales de Andreani guardadas.", error: null };
}
