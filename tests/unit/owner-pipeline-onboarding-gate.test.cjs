// owner-pipeline-onboarding-gate.test.cjs
//
// Regression tests for the OnboardingLlmStage greedy interception bug.
// Pipeline order post-OA Phase 4 cleanup (2026-05-30 — Flash classifier removed):
//
//   Confirmation → DeterministicDispatch → FiscalSetup
//   → OnboardingAgent (release-on-action-intent via mightBeActionIntent regex)
//   → DailyNudge → SalePaymentPrompt → StockPriceRescue
//   → Supervisor Pro (Layer 3)
//
// The Flash classifier (ownerIntentClassifier, Layer 2) was removed because:
//   - All 6 dispatchable intents (PAYMENT_LINK, INVOICE_*, SHIPPING_*) already
//     had duplicate L1 labels (3z, 9, 8a) making Flash redundant.
//   - OA (USE_OWNER_ASSISTANT=true) now owns all mutation intents.
//   - Onboarding release gate replaced by mightBeActionIntent() regex (no LLM call).
//
// Source (verified HTTP 200 2026-05-28):
//   ADK Coordinator / Collaborative agents:
//     https://adk.dev/workflows/collaboration/
//   Cloud Architecture Center Coordinator Pattern:
//     https://docs.cloud.google.com/architecture/choose-design-pattern-agentic-ai-system

"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { buildOwnerStages } = require("../../src/app/api/business-assistant/_lib/owner-handler.stages.ts");

test("owner pipeline: ownerDeterministicDispatch appears before ownerOnboardingAgent", () => {
  const stages = buildOwnerStages();
  const names = stages.map((s) => s.name);

  const deterministicIdx = names.indexOf("ownerDeterministicDispatch");
  const onboardingIdx = names.indexOf("ownerOnboardingAgent");

  assert.ok(
    deterministicIdx !== -1,
    "ownerDeterministicDispatch stage must exist in the pipeline",
  );
  assert.ok(
    onboardingIdx !== -1,
    "ownerOnboardingAgent stage must exist in the pipeline",
  );
  assert.ok(
    deterministicIdx < onboardingIdx,
    `ownerDeterministicDispatch (index ${deterministicIdx}) must come before ` +
      `ownerOnboardingAgent (index ${onboardingIdx}) so NLU fast-paths intercept ` +
      `known intents before the onboarding agent absorbs them`,
  );
});

test("owner pipeline: ownerFiscalSetup appears before ownerOnboardingAgent", () => {
  const stages = buildOwnerStages();
  const names = stages.map((s) => s.name);

  const fiscalIdx = names.indexOf("ownerFiscalSetup");
  const onboardingIdx = names.indexOf("ownerOnboardingAgent");

  assert.ok(
    fiscalIdx !== -1,
    "ownerFiscalSetup stage must exist in the pipeline",
  );
  assert.ok(
    onboardingIdx !== -1,
    "ownerOnboardingAgent stage must exist in the pipeline",
  );
  assert.ok(
    fiscalIdx < onboardingIdx,
    `ownerFiscalSetup (index ${fiscalIdx}) must come before ` +
      `ownerOnboardingAgent (index ${onboardingIdx}) so fiscal intents ` +
      `(factura, comprobante, arca) are not absorbed by onboarding`,
  );
});

test("owner pipeline: ownerIntentClassifier stage is NOT present (removed OA Phase 4)", () => {
  // Flash classifier was removed 2026-05-30. This test guards against accidental
  // re-introduction. The onboarding release gate now uses mightBeActionIntent() regex.
  const stages = buildOwnerStages();
  const names = stages.map((s) => s.name);

  assert.ok(
    !names.includes("ownerIntentClassifier"),
    "ownerIntentClassifier stage must NOT be in the pipeline (removed OA Phase 4 — L1 labels cover all dispatchable intents)",
  );
});

test("owner pipeline: regression guard — OnboardingAgent appears BEFORE StockPriceRescue and Supervisor", () => {
  // This preserves the original intent: OnboardingAgent must have a chance to
  // claim the turn before fallback stages and the Supervisor LLM.
  const stages = buildOwnerStages();
  const names = stages.map((s) => s.name);

  const onboardingIdx = names.indexOf("ownerOnboardingAgent");
  const rescueIdx = names.indexOf("ownerStockPriceRescue");
  const supervisorIdx = names.indexOf("ownerSupervisor");

  assert.ok(onboardingIdx !== -1, "ownerOnboardingAgent must exist");
  assert.ok(
    onboardingIdx < rescueIdx,
    `ownerOnboardingAgent (${onboardingIdx}) must come before ownerStockPriceRescue (${rescueIdx})`,
  );
  assert.ok(
    onboardingIdx < supervisorIdx,
    `ownerOnboardingAgent (${onboardingIdx}) must come before ownerSupervisor (${supervisorIdx})`,
  );
});

test("owner pipeline: complete stage order includes all expected stages", () => {
  const stages = buildOwnerStages();
  const names = stages.map((s) => s.name);

  // Every critical stage must be present. ownerIntentClassifier removed 2026-05-30.
  const required = [
    "ownerConfirmationFastPath",
    "ownerDeterministicDispatch",
    "ownerFiscalSetup",
    "ownerOnboardingAgent",
    "ownerDailyNudge",
    "ownerSalePaymentPrompt",
    "ownerStockPriceRescue",
    "ownerSupervisor",
  ];

  for (const name of required) {
    assert.ok(
      names.includes(name),
      `Stage "${name}" must be present in the owner pipeline`,
    );
  }
});
