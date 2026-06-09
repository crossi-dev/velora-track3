// State-building helpers for ownerOnboardingAgentStage.
//
// Split from owner-handler.stages-onboarding-agent.ts per the 300-LOC contract.
// These functions are exported and consumed by:
//   - owner-handler.stages-onboarding-agent.ts (runtime stage)
//   - src/app/api/agents/onboarding/jsonrpc/route.ts (A2A trust fix, design §7.3)
//   - tests/unit/onboarding-currently-due-invariant.test.cjs (buildCurrentlyDue tests)
//   - tests/unit/onboarding-history-mapper.test.cjs (mapRecentHistory tests)

import { cloudLog } from "@/lib/cloud-logger";
import { loadSupervisorContext } from "@/app/api/supervisor/_lib/load-context";
import type {
  OnboardingAgentInput,
  OnboardingState,
} from "@/lib/adk/onboarding-agent.contract";
import type { OnboardingCurrentlyDue } from "./onboarding-session-state";

// Build the OnboardingState slice from the supervisor business context.
// The agent only needs the state-machine flags; the rest of supCtx is for
// downstream ops stages.
// Exported so the A2A route can derive state from the same source instead of
// trusting caller-supplied input (design §7.3 A2A trust fix).
export function buildOnboardingState(supCtx: Awaited<ReturnType<typeof loadSupervisorContext>>): OnboardingState {
  return {
    businessNameSet: supCtx.businessNameSet,
    paymentMethodsSet: supCtx.paymentMethodsSet,
    paymentMethodsIncludeTransferencia: supCtx.paymentMethodsIncludeTransferencia,
    transferAlias: supCtx.transferAlias,
    transferAliasSet: supCtx.transferAliasSet,
    postalCodeSet: supCtx.postalCodeSet,
    courierPreferenceSet: supCtx.courierPreferenceSet,
    courierPreference: supCtx.courierPreference,
    whatsappPhoneSet: supCtx.whatsappPhoneSet,
    productCount: supCtx.productCount,
    pendingStockProduct: supCtx.pendingStockProduct,
    mercadoPagoSelected: supCtx.mercadoPagoSelected,
    mercadoPagoConnected: supCtx.mercadoPagoConnected,
    mercadoPagoOnboardingDeferred: supCtx.mercadoPagoOnboardingDeferred,
    customerCount: supCtx.customerCount,
    customersOnboardingSkipped: supCtx.customersOnboardingSkipped,
    arcaCertConnected: supCtx.arcaCertConnected,
    arcaOnboardingDeferred: supCtx.arcaOnboardingDeferred,
    courierCredentialsConnected: supCtx.courierCredentialsConnected,
    andreaniOnboardingDeferred: supCtx.andreaniOnboardingDeferred,
    arcaPendingStep: supCtx.arcaPendingStep,
    andreaniPendingStep: supCtx.andreaniPendingStep,
    skippedCatalog: supCtx.skippedCatalog,
    firstSalePromptShown: supCtx.firstSalePromptShown,
  };
}

// Derives currently_due from supCtx so the runner can inject it as session.state
// JSON (ADK session.state pattern). Maps the 2 currently_due fields (name +
// catalog) from existing supervisor context flags — no new DB reads required.
// Onboarding v3 (2026-06-04): payment + shipping are eventually_due (the
// SetupChecklist card), no longer derived here.
// Source: https://google.github.io/adk-docs/sessions/state/
// Exported for unit tests only — not part of the public module API.
export function buildCurrentlyDue(supCtx: Awaited<ReturnType<typeof loadSupervisorContext>>): OnboardingCurrentlyDue {
  const result: OnboardingCurrentlyDue = {
    business_name: supCtx.businessNameSet ? (supCtx.businessName ?? "configurado") : null,
    catalog_ready: supCtx.productCount > 0 || supCtx.skippedCatalog,
  };

  // Invariant assertion: validate derived currently_due is consistent with source flags.
  // Non-throwing in prod (logs WARNING) — a hard throw here would break the onboarding
  // chat turn which is worse than a silent drift. Throws in development for fast feedback.
  const inconsistencies: string[] = [];
  if (supCtx.businessNameSet && result.business_name === null)
    inconsistencies.push("businessNameSet=true but business_name=null");
  if (!supCtx.businessNameSet && result.business_name !== null)
    inconsistencies.push("businessNameSet=false but business_name is non-null");

  if (inconsistencies.length > 0) {
    const msg = `buildCurrentlyDue invariant violated: ${inconsistencies.join("; ")}`;
    if (process.env.NODE_ENV === "development") {
      throw new Error(msg);
    }
    cloudLog({
      severity: "WARNING",
      component: "OnboardingAgent",
      action: "CURRENTLY_DUE_INVARIANT_VIOLATED",
      a2a_transfer: false,
      message: msg,
      data: { inconsistencies },
    });
  }

  return result;
}

// Recent history adapter: pipeline supplies PendingConfirmationCarrier shape
// (role: "user" | "assistant", text: string) — the field is `role`, NOT `kind`.
// buildRecentHistory in route-history-filter.ts maps kind→role before the array
// reaches the pipeline, so we read h.role here.
// The agent only needs role + text. Last 6 turns is plenty for repair context.
// Unknown roles (neither "user" nor "assistant") are dropped with a debug log
// rather than silently mapped, which could corrupt repair context.
// Exported for unit tests only — not part of the public module API.
export function mapRecentHistory(
  history: Array<{ role?: string; text?: string }> | undefined,
): OnboardingAgentInput["recentHistory"] {
  if (!history || history.length === 0) return [];
  const mapped = history.slice(-6).map((h): { role: "owner" | "assistant"; text: string } | null => {
    if (h.role === "user") return { role: "owner", text: h.text ?? "" };
    if (h.role === "assistant") return { role: "assistant", text: h.text ?? "" };
    cloudLog({
      severity: "DEBUG",
      component: "OnboardingAgent",
      action: "ONBOARDING_HISTORY_UNKNOWN_KIND",
      a2a_transfer: false,
      message: `mapRecentHistory: dropped entry with unknown role '${h.role}'`,
    });
    return null;
  });
  return mapped.filter((h): h is { role: "owner" | "assistant"; text: string } => h !== null);
}
