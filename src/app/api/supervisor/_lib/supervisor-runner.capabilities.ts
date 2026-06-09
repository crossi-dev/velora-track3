// supervisor-runner.capabilities.ts — Capability state-delta builder for the Supervisor ADK runner.
//
// Extracted from supervisor-runner.ts to keep that file under the 300-line server limit.
//
// Step 1.5b — capability-aware orchestration backbone.
// Loads per-tenant capability flags and returns an app:* stateDelta map for ADK
// session state injection. The CapabilityToolset reads these flags at tool-selection
// time to gate provider-dependent tools.
//
// Source: https://adk.dev/sessions/state/ — app:* prefix scope.

import { loadBusinessCapabilities } from "@/lib/business-capabilities";
import { isAndreaniMockActive } from "@/app/api/agents/andreani/_lib/andreani-mock";
import { isMpMockActive } from "@/app/api/integrations/mp/_lib/config";

/**
 * Build the `app:*` stateDelta map for a given businessId.
 * Returns an empty record for empty/missing businessId (fail-open: all tools shown).
 *
 * DB read overhead acceptable — no in-process cache ensures freshness when the
 * owner connects a new service during an active session.
 */
export async function buildCapabilityStateDelta(
  businessId: string | undefined,
): Promise<Record<string, boolean>> {
  if (!businessId) return {};

  const caps = await loadBusinessCapabilities(businessId);

  return {
    "app:whatsapp_business_connected": caps.whatsapp_business,
    "app:whatsapp_phone_set": caps.whatsapp_phone,
    "app:mercadopago_connected": caps.mercadopago,
    "app:alias_cbu_set": caps.alias_cbu,
    "app:arca_connected": caps.arca,
    "app:andreani_connected": caps.andreani,
    // Demo/mock: when ANDREANI_MOCK_MODE is active (and allowed in this env),
    // expose shipping tools even without a real CourierCredential. Kept as a
    // SEPARATE flag so app:andreani_connected stays truthful for onboarding/UI
    // ("connected" = real creds). Gates OR the two. Non-throwing read — see
    // isAndreaniMockActive() rationale in andreani-mock.ts.
    // Per-business gate: passes businessId so only demo businesses get mock mode.
    "app:andreani_mock": isAndreaniMockActive(businessId),
    // Demo/mock: when MP_MOCK_MODE is active (and allowed in this env), expose
    // payment tools even without a real MpConnection row. Same pattern as
    // app:andreani_mock — separate flag keeps app:mercadopago_connected truthful.
    // Non-throwing: isMpMockActive() returns false in prod without MP_ALLOW_MOCK_IN_PROD.
    // Per-business gate: passes businessId so only demo businesses get mock mode.
    "app:mercadopago_mock": isMpMockActive(businessId),
  };
}
