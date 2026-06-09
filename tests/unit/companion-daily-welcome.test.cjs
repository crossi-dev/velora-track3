// Unit tests for employeeDailyWelcomeStage.
//
// Strategy mirrors owner-daily-nudge.test.cjs:
//   - Test the pure `isGreetingOrEmpty` export directly.
//   - Exercise the stage logic via an inline stub harness (no real DB).
//
// Covers:
//   1. fires on empty/greeting turn when graduated employee has no welcome today
//   2. does NOT fire on a substantive operational message (CRITICAL anti-hijack)
//   3. does NOT fire twice in one day (idempotency)
//   4. fires again the next day
//   5. does NOT fire on first-time interaction (onboarding NOT complete yet)

const assert = require("node:assert/strict");
const test = require("node:test");

// ── ENV stubs (required before any @/ import resolves prisma) ─────────────
process.env.AUTH_SECRET = process.env.AUTH_SECRET || "test-secret-not-for-production";
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://test:test@localhost:5432/test";
process.env.NEXTAUTH_URL = process.env.NEXTAUTH_URL || "http://localhost:3000";
process.env.GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "test-client-id";
process.env.GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "test-client-secret";

// ── Import pure-logic export ──────────────────────────────────────────────
const {
  isGreetingOrEmpty,
} = require("../../src/app/api/business-assistant/_lib/employee-handler.stages-daily-welcome.ts");

// ── isGreetingOrEmpty ─────────────────────────────────────────────────────

test("isGreetingOrEmpty: empty string → true", () => {
  assert.equal(isGreetingOrEmpty(""), true);
  assert.equal(isGreetingOrEmpty("   "), true);
});

test("isGreetingOrEmpty: bare greetings → true", () => {
  assert.equal(isGreetingOrEmpty("hola"), true);
  assert.equal(isGreetingOrEmpty("Hola!"), true);
  assert.equal(isGreetingOrEmpty("buenas"), true);
  assert.equal(isGreetingOrEmpty("buen día"), true);
  assert.equal(isGreetingOrEmpty("buenos días"), true);
  assert.equal(isGreetingOrEmpty("buenas noches"), true);
  assert.equal(isGreetingOrEmpty("buenas tardes"), true);
  assert.equal(isGreetingOrEmpty("hey"), true);
  assert.equal(isGreetingOrEmpty("hi"), true);
});

test("isGreetingOrEmpty: substantive messages → false (CRITICAL anti-hijack)", () => {
  assert.equal(isGreetingOrEmpty("vendí 3 lattes"), false);
  assert.equal(isGreetingOrEmpty("¿cuánto stock tengo?"), false);
  assert.equal(isGreetingOrEmpty("registrar venta"), false);
  assert.equal(isGreetingOrEmpty("dame el reporte de hoy"), false);
  assert.equal(isGreetingOrEmpty("hola, vendí 2 medialunas"), false);
  assert.equal(isGreetingOrEmpty("necesito cargar mercadería"), false);
  assert.equal(isGreetingOrEmpty("pedir pedido al proveedor"), false);
});

// ── Stage integration harness ─────────────────────────────────────────────
//
// Replicates the stage logic with in-memory stubs for DB calls.
// Tests the behavior of each decision branch without requiring a real DB.

function makeCtx({ text = "" } = {}) {
  const responded = [];
  const respond = async (body) => {
    responded.push(body);
    return { json: () => body };
  };
  const trace = { add: () => {}, toJSON: () => null };
  const latency = { start: () => {}, end: () => {}, setMeta: () => {}, emit: () => {} };

  return {
    ctx: {
      params: {
        text,
        businessId: "biz_test",
        actorEmployeeId: "emp_test",
        actorUserId: "user_test",
        respond,
        trace,
        latency,
      },
      onboardingPrefix: "",
      modelResult: null,
      parsed: null,
      safeIntent: null,
      answer: null,
    },
    responded,
  };
}

/**
 * Runs the stage decision logic with stubs.
 * Parameters mirror the fields the stage reads:
 *   - text: incoming message
 *   - onboardingCompletedAt: null = not graduated (first-time onboarding flow owns it)
 *   - lastWelcomeAt: null = never welcomed today; ISO string = welcomed at that time
 *   - shouldStamp: controls whether the updateMany stub "wins" the race
 *   - activeRules: list of { message } objects for the rules summary
 */
async function runStageWithStubs({
  text = "",
  onboardingCompletedAt = new Date(), // default: graduated
  lastWelcomeAt = null,
  shouldStamp = true,
  activeRules = [],
} = {}) {
  const { isGreetingOrEmpty: guard } = require("../../src/app/api/business-assistant/_lib/employee-handler.stages-daily-welcome.ts");

  const { ctx, responded } = makeCtx({ text });

  // Step 1: text guard (CRITICAL anti-hijack)
  if (!guard(text)) return { result: null, responded };

  // Step 2: employee must be authenticated
  if (!ctx.params.actorEmployeeId) return { result: null, responded };

  // Step 3: onboarding gate — daily welcome only fires for graduated employees
  if (!onboardingCompletedAt) return { result: null, responded };

  // Step 4: once-per-day ART check
  const now = new Date();
  const artMs = now.getTime() + (-3) * 60 * 60 * 1000;
  const dateStr = new Date(artMs).toISOString().slice(0, 10);
  const dayStart = new Date(`${dateStr}T03:00:00Z`);

  if (lastWelcomeAt && new Date(lastWelcomeAt) >= dayStart) {
    return { result: null, responded };
  }

  // Step 5: stamp (stub — simulate success/failure via shouldStamp)
  if (!shouldStamp) return { result: null, responded };

  // Step 6: build greeting
  const rulesPart = activeRules.length > 0
    ? ` Recordá: ${activeRules.slice(0, 2).map((r) => r.message).join(" · ")}.`
    : "";
  const employeeName = "María";
  const welcomeText =
    `Buen día, ${employeeName}.${rulesPart} ` +
    "Podés decirme: registrar una venta, consultar stock, hacer una nota de gasto, o pedir un pedido al proveedor. " +
    "Estoy acá.";

  const result = await ctx.params.respond({ answer: welcomeText, actions: [] });
  return { result, responded };
}

// ── Stage behavior tests ──────────────────────────────────────────────────

test("stage: fires on empty text for graduated employee with no welcome today", async () => {
  const { result, responded } = await runStageWithStubs({
    text: "",
    onboardingCompletedAt: new Date(),
    lastWelcomeAt: null,
    shouldStamp: true,
  });
  assert.ok(result !== null, "should return a response");
  assert.equal(responded.length, 1);
  assert.ok(responded[0].answer.includes("Buen día"));
  assert.ok(responded[0].answer.includes("Podés decirme"));
});

test("stage: fires on bare greeting for graduated employee", async () => {
  const { result, responded } = await runStageWithStubs({
    text: "hola",
    onboardingCompletedAt: new Date(),
    lastWelcomeAt: null,
    shouldStamp: true,
  });
  assert.ok(result !== null, "should return a response");
  assert.equal(responded.length, 1);
});

test("stage: does NOT fire on substantive message (CRITICAL anti-hijack)", async () => {
  const { result, responded } = await runStageWithStubs({
    text: "vendí 3 lattes",
    onboardingCompletedAt: new Date(),
    lastWelcomeAt: null,
    shouldStamp: true,
  });
  assert.equal(result, null, "substantive message must not be intercepted");
  assert.equal(responded.length, 0);
});

test("stage: does NOT fire when onboarding is NOT complete (first-time onboarding owns it)", async () => {
  const { result, responded } = await runStageWithStubs({
    text: "",
    onboardingCompletedAt: null, // not graduated
    lastWelcomeAt: null,
    shouldStamp: true,
  });
  assert.equal(result, null, "must not fire before onboarding completes");
  assert.equal(responded.length, 0);
});

test("stage: does NOT fire twice in one day (lastWelcomeAt already today)", async () => {
  // Simulate a welcome that fired 2 hours ago (same ART day)
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const { result, responded } = await runStageWithStubs({
    text: "hola",
    onboardingCompletedAt: new Date(),
    lastWelcomeAt: twoHoursAgo,
    shouldStamp: true,
  });
  assert.equal(result, null, "must not fire a second time the same day");
  assert.equal(responded.length, 0);
});

test("stage: fires again when lastWelcomeAt is from yesterday", async () => {
  // Simulate a welcome that fired 25 hours ago (different ART day)
  const yesterday = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  const { result, responded } = await runStageWithStubs({
    text: "",
    onboardingCompletedAt: new Date(),
    lastWelcomeAt: yesterday,
    shouldStamp: true,
  });
  assert.ok(result !== null, "should fire again the next day");
  assert.equal(responded.length, 1);
});

test("stage: includes rules summary when active rules are present", async () => {
  const { responded } = await runStageWithStubs({
    text: "buenas",
    onboardingCompletedAt: new Date(),
    lastWelcomeAt: null,
    shouldStamp: true,
    activeRules: [
      { message: "Saludá al cliente al entrar" },
      { message: "Usá el uniforme" },
    ],
  });
  assert.equal(responded.length, 1);
  assert.ok(responded[0].answer.includes("Recordá"), "must include rules reminder");
  assert.ok(responded[0].answer.includes("Saludá al cliente"), "must include rule text");
});

test("stage: greeting without rules is still useful", async () => {
  const { responded } = await runStageWithStubs({
    text: "",
    onboardingCompletedAt: new Date(),
    lastWelcomeAt: null,
    shouldStamp: true,
    activeRules: [], // no rules set
  });
  assert.equal(responded.length, 1);
  assert.ok(responded[0].answer.includes("Buen día"), "must greet even with no rules");
  assert.ok(responded[0].answer.includes("Podés decirme"), "must list capabilities");
});

test("stage: does NOT fire when stamp fails (race condition)", async () => {
  const { result, responded } = await runStageWithStubs({
    text: "hola",
    onboardingCompletedAt: new Date(),
    lastWelcomeAt: null,
    shouldStamp: false, // another request won the race
  });
  assert.equal(result, null, "must not fire when stamp fails");
  assert.equal(responded.length, 0);
});
