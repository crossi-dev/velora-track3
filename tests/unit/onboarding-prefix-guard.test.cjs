/**
 * Regression tests for the onboarding-prefix contamination bug.
 *
 * Root cause: ctx.onboardingPrefix was being prepended inside preModelStage
 * and modelStage, which fire for concrete intents (sale, stock_query, etc.).
 * The fix: those stages no longer touch ctx.onboardingPrefix. Only
 * preFilterStage emits the welcome prefix, and it only fires for
 * greeting/empty inputs that don't resolve to any concrete intent.
 *
 * These tests verify the two invariants at the source level:
 *   1. preModelStage no longer contains the prefix-prepend pattern.
 *   2. modelStage assigns ctx.answer = modelResult.answer unconditionally
 *      (no ternary that would prepend ctx.onboardingPrefix).
 *
 * Behavioral note: preFilterStage (ShapeResponse phase) only fires when
 * no upstream stage returned — i.e., only for greeting/empty/unknown inputs.
 * By design: if the pipeline reaches preFilterStage, there is no concrete
 * intent, so it is safe to emit the onboarding welcome prefix there.
 * Concrete intents (sale, stock_query, create_customer, etc.) are handled
 * by preModelStage or modelStage — those must never touch the prefix.
 */

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

// stages-a.ts re-exports modelStage from stages-b.ts (split for 300-line limit).
// The invariants about modelStage body must be checked in stages-b.ts.
const SOURCE_A_PATH = path.resolve(
  __dirname,
  "../../src/app/api/business-assistant/_lib/employee-handler.stages-a.ts",
);
const SOURCE_B_PATH = path.resolve(
  __dirname,
  "../../src/app/api/business-assistant/_lib/employee-handler.stages-b.ts",
);

const source = fs.readFileSync(SOURCE_A_PATH, "utf8");
const sourceB = fs.readFileSync(SOURCE_B_PATH, "utf8");

// ── Invariant 1: preModelStage must not prepend onboarding prefix ─────────────

test("preModelStage: does not contain the prefix-prepend cacheAndReturn pattern", () => {
  // The old code body inside preModelStage built a `prefixed` variable
  // and returned cacheAndReturn with the combined prefix + answer.
  // Both signatures must be absent from the current source.
  assert.ok(
    !source.includes("onboardingPrefix}\n\n${body.answer}"),
    "preModelStage must not contain the template literal that prepended the welcome prefix to the pre-model response body",
  );
  assert.ok(
    !source.includes("const prefixed = typeof body.answer"),
    "preModelStage must not contain the 'prefixed' variable that appended the welcome message",
  );
});

// ── Invariant 2: modelStage must assign ctx.answer unconditionally ─────────────

test("modelStage: ctx.answer is assigned to modelResult.answer without a prefix ternary", () => {
  // modelStage body lives in stages-b.ts (split from stages-a for the 300-line limit).
  // stages-a.ts only re-exports it: export { modelStage } from "./employee-handler.stages-b"
  // The old code was a ternary:
  //   ctx.answer = (ctx.onboardingPrefix && recentHistory.length === 0)
  //     ? `${ctx.onboardingPrefix}\n\n${modelResult.answer}`
  //     : modelResult.answer;
  // The new code must be the unconditional assignment:
  //   ctx.answer = modelResult.answer;
  assert.ok(
    sourceB.includes("ctx.answer = modelResult.answer;"),
    "modelStage must assign ctx.answer = modelResult.answer (unconditional, no prefix ternary)",
  );
  assert.ok(
    !sourceB.includes("`${ctx.onboardingPrefix}\\n\\n${modelResult.answer}`"),
    "modelStage must not contain the ternary that prepended ctx.onboardingPrefix to modelResult.answer",
  );
});

// ── Invariant 3: preFilterStage still emits the onboarding prefix for greetings

test("preFilterStage: source still contains the onboardingPrefix emit for greeting/empty inputs", () => {
  // preFilterStage is the only correct place to emit the welcome prefix.
  // It fires in ShapeResponse — only when no upstream stage returned a result.
  // Verify the welcome emission logic is still present.
  assert.ok(
    source.includes("ctx.onboardingPrefix") && source.includes("preFilterStage"),
    "preFilterStage must still reference ctx.onboardingPrefix so greetings get the welcome message",
  );
});

// ── Cross-check: onboardingStage still sets ctx.onboardingPrefix ──────────────

test("onboardingStage: still sets ctx.onboardingPrefix from buildEmployeeOnboardingResponse", () => {
  assert.ok(
    source.includes("ctx.onboardingPrefix = onboarding.message"),
    "onboardingStage must still set ctx.onboardingPrefix so preFilterStage can read it",
  );
});
