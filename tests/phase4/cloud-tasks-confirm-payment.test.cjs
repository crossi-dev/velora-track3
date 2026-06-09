// Integration tests for the Cloud Tasks confirm-payment worker.
//
// Covers:
//   1. Auth — OIDC valid: proceeds normally.
//   2. Auth — shared secret only: proceeds with WARNING log (transitional).
//   3. Auth — neither: returns { ok: false, error: "auth_failed" } (200).
//   4. Already-confirmed intent: returns { ok: true, outcome: "already_settled" } (200).
//   5. Transient error in confirmPaymentIntentUseCase: throws → returns 500 → Cloud Tasks retries.
//   6. Terminal success: confirm + side effects awaited → returns { ok: true, outcome: "confirmed" }.
//
// Note: google-auth-library OAuth2Client.verifyIdToken is mocked to control OIDC results.

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  clearMockModules,
  resetSourceModules,
  setMockModule,
} = require("./module-hooks.cjs");

// --- helpers ---

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

function makeNextServerMock() {
  return {
    NextRequest: class NextRequest {},
    NextResponse: { json: jsonResponse },
  };
}

function makeTaskRequest({
  oidcToken = null,
  secret = null,
  queueName = "velora-payment-confirm",
  body = {},
} = {}) {
  const headers = new Headers();
  if (oidcToken) headers.set("authorization", `Bearer ${oidcToken}`);
  if (secret) headers.set("x-velora-task-secret", secret);
  if (queueName) headers.set("x-cloudtasks-queuename", queueName);
  return {
    headers,
    async json() {
      return body;
    },
  };
}

function makeFakePrisma(intentOverride = null) {
  return {
    paymentIntent: {
      findFirst: async () =>
        intentOverride ?? {
          id: "pi001aaaaaaaaaaaaaaaaaaa",
          estado: "pending",
          monto: 1000,
          createdByEmployeeId: null,
          matchedCustomerId: null,
        },
    },
    customer: {
      findUnique: async () => null,
    },
  };
}

// --- tests ---

test("confirm worker: OIDC valid → processes and awaits side effects", async () => {
  clearMockModules();
  resetSourceModules();

  let sideEffectsCalled = false;

  setMockModule("next/server", makeNextServerMock());
  setMockModule("google-auth-library", {
    OAuth2Client: class {
      async verifyIdToken() {
        return {
          getPayload: () => ({ email: "tasks@velora.iam.gserviceaccount.com" }),
        };
      }
    },
  });
  setMockModule("@/lib/cloud-logger", {
    cloudLog: () => {},
    runWithTraceContext: (_headers, fn) => fn(),
  });
  setMockModule("@/lib/prisma", { prisma: makeFakePrisma() });
  setMockModule("@/app/api/payment-intents/_lib/payment-intent-use-case", {
    confirmPaymentIntentUseCase: async () => ({
      outcome: "confirmed",
      paymentIntentId: "pi001aaaaaaaaaaaaaaaaaaa",
      saleId: null,
    }),
  });
  setMockModule("@/app/api/payment-intents/_lib/payment-intent-post-confirm", {
    runPostConfirmSideEffects: async () => {
      sideEffectsCalled = true;
    },
  });
  setMockModule("@/app/api/integrations/mp/_lib/webhook-push", {
    pushOnConfirm: () => {},
  });

  const { POST } = require("@/app/api/internal/tasks/confirm-payment/route");
  const req = makeTaskRequest({
    oidcToken: "valid-token",
    queueName: "velora-payment-confirm",
    body: { paymentIntentId: "pi001aaaaaaaaaaaaaaaaaaa", businessId: "biz001" },
  });
  const res = await POST(req);
  const data = await res.json();

  assert.equal(data.ok, true);
  assert.equal(data.outcome, "confirmed");
  assert.equal(sideEffectsCalled, true, "side effects must be awaited");

  clearMockModules();
  resetSourceModules();
});

test("confirm worker: shared-secret only → proceeds (transitional) with WARNING", async () => {
  clearMockModules();
  resetSourceModules();

  const warnings = [];

  setMockModule("next/server", makeNextServerMock());
  setMockModule("google-auth-library", {
    OAuth2Client: class {
      async verifyIdToken() {
        throw new Error("invalid token");
      }
    },
  });
  setMockModule("@/lib/cloud-logger", {
    cloudLog: (entry) => {
      if (entry.action === "TASK_CONFIRM_AUTH_SHARED_SECRET_FALLBACK") {
        warnings.push(entry.action);
      }
    },
    runWithTraceContext: (_headers, fn) => fn(),
  });
  setMockModule("@/lib/prisma", { prisma: makeFakePrisma() });
  setMockModule("@/app/api/payment-intents/_lib/payment-intent-use-case", {
    confirmPaymentIntentUseCase: async () => ({
      outcome: "confirmed",
      paymentIntentId: "pi001aaaaaaaaaaaaaaaaaaa",
      saleId: null,
    }),
  });
  setMockModule("@/app/api/payment-intents/_lib/payment-intent-post-confirm", {
    runPostConfirmSideEffects: async () => {},
  });
  setMockModule("@/app/api/integrations/mp/_lib/webhook-push", {
    pushOnConfirm: () => {},
  });

  // Set env so EXPECTED_SECRET matches
  process.env.CRON_SECRET = "test-cron-secret";

  const { POST } = require("@/app/api/internal/tasks/confirm-payment/route");
  const req = makeTaskRequest({
    secret: "test-cron-secret",
    queueName: "velora-payment-confirm",
    body: { paymentIntentId: "pi001aaaaaaaaaaaaaaaaaaa", businessId: "biz001" },
  });
  const res = await POST(req);
  const data = await res.json();

  assert.equal(data.ok, true, "shared-secret fallback must succeed");
  assert.equal(warnings.length, 1, "must emit SHARED_SECRET_FALLBACK warning");

  delete process.env.CRON_SECRET;
  clearMockModules();
  resetSourceModules();
});

test("confirm worker: no auth → 200 auth_failed (no retry)", async () => {
  clearMockModules();
  resetSourceModules();

  setMockModule("next/server", makeNextServerMock());
  setMockModule("google-auth-library", {
    OAuth2Client: class {
      async verifyIdToken() {
        throw new Error("invalid");
      }
    },
  });
  setMockModule("@/lib/cloud-logger", {
    cloudLog: () => {},
    runWithTraceContext: (_headers, fn) => fn(),
  });
  setMockModule("@/lib/prisma", { prisma: makeFakePrisma() });
  setMockModule("@/app/api/payment-intents/_lib/payment-intent-use-case", {
    confirmPaymentIntentUseCase: async () => {
      throw new Error("should not be called");
    },
  });
  setMockModule("@/app/api/payment-intents/_lib/payment-intent-post-confirm", {
    runPostConfirmSideEffects: async () => {},
  });
  setMockModule("@/app/api/integrations/mp/_lib/webhook-push", {
    pushOnConfirm: () => {},
  });

  const { POST } = require("@/app/api/internal/tasks/confirm-payment/route");
  const req = makeTaskRequest({ queueName: "velora-payment-confirm", body: {} });
  const res = await POST(req);
  const data = await res.json();

  assert.equal(res.status, 200, "auth failure must be 200 to suppress Cloud Tasks retry");
  assert.equal(data.ok, false);
  assert.equal(data.error, "auth_failed");

  clearMockModules();
  resetSourceModules();
});

test("confirm worker: already-confirmed intent → 200 already_settled (idempotent skip)", async () => {
  clearMockModules();
  resetSourceModules();

  setMockModule("next/server", makeNextServerMock());
  setMockModule("google-auth-library", {
    OAuth2Client: class {
      async verifyIdToken() {
        return { getPayload: () => ({ email: "sa@test" }) };
      }
    },
  });
  setMockModule("@/lib/cloud-logger", {
    cloudLog: () => {},
    runWithTraceContext: (_headers, fn) => fn(),
  });
  setMockModule("@/lib/prisma", {
    prisma: makeFakePrisma({
      id: "pi001aaaaaaaaaaaaaaaaaaa",
      estado: "confirmed",
      monto: 1000,
      createdByEmployeeId: null,
      matchedCustomerId: null,
    }),
  });
  setMockModule("@/app/api/payment-intents/_lib/payment-intent-use-case", {
    confirmPaymentIntentUseCase: async () => {
      throw new Error("should not be called for already-confirmed");
    },
  });
  setMockModule("@/app/api/payment-intents/_lib/payment-intent-post-confirm", {
    runPostConfirmSideEffects: async () => {},
  });
  setMockModule("@/app/api/integrations/mp/_lib/webhook-push", {
    pushOnConfirm: () => {},
  });

  const { POST } = require("@/app/api/internal/tasks/confirm-payment/route");
  const req = makeTaskRequest({
    oidcToken: "valid",
    queueName: "velora-payment-confirm",
    body: { paymentIntentId: "pi001aaaaaaaaaaaaaaaaaaa", businessId: "biz001" },
  });
  const res = await POST(req);
  const data = await res.json();

  assert.equal(data.ok, true);
  assert.equal(data.outcome, "already_settled");

  clearMockModules();
  resetSourceModules();
});

test("confirm worker: transient useCase error → 500 → Cloud Tasks retries", async () => {
  clearMockModules();
  resetSourceModules();

  setMockModule("next/server", makeNextServerMock());
  setMockModule("google-auth-library", {
    OAuth2Client: class {
      async verifyIdToken() {
        return { getPayload: () => ({ email: "sa@test" }) };
      }
    },
  });
  setMockModule("@/lib/cloud-logger", {
    cloudLog: () => {},
    runWithTraceContext: (_headers, fn) => fn(),
  });
  setMockModule("@/lib/prisma", { prisma: makeFakePrisma() });
  setMockModule("@/app/api/payment-intents/_lib/payment-intent-use-case", {
    confirmPaymentIntentUseCase: async () => {
      throw new Error("DB connection timeout");
    },
  });
  setMockModule("@/app/api/payment-intents/_lib/payment-intent-post-confirm", {
    runPostConfirmSideEffects: async () => {},
  });
  setMockModule("@/app/api/integrations/mp/_lib/webhook-push", {
    pushOnConfirm: () => {},
  });

  const { POST } = require("@/app/api/internal/tasks/confirm-payment/route");
  const req = makeTaskRequest({
    oidcToken: "valid",
    queueName: "velora-payment-confirm",
    body: { paymentIntentId: "pi001aaaaaaaaaaaaaaaaaaa", businessId: "biz001" },
  });

  // The worker wraps handlePost in runWithTraceContext; a thrown error propagates
  // as a 500 from Next.js unless caught. The route module should let it throw so
  // Cloud Tasks sees 5xx and retries.
  await assert.rejects(
    () => POST(req),
    /DB connection timeout/,
    "transient error must propagate so Cloud Tasks retries",
  );

  clearMockModules();
  resetSourceModules();
});

test("confirm worker: side-effect error → propagates → Cloud Tasks retries", async () => {
  clearMockModules();
  resetSourceModules();

  setMockModule("next/server", makeNextServerMock());
  setMockModule("google-auth-library", {
    OAuth2Client: class {
      async verifyIdToken() {
        return { getPayload: () => ({ email: "sa@test" }) };
      }
    },
  });
  setMockModule("@/lib/cloud-logger", {
    cloudLog: () => {},
    runWithTraceContext: (_headers, fn) => fn(),
  });
  setMockModule("@/lib/prisma", { prisma: makeFakePrisma() });
  setMockModule("@/app/api/payment-intents/_lib/payment-intent-use-case", {
    confirmPaymentIntentUseCase: async () => ({
      outcome: "confirmed",
      paymentIntentId: "pi001aaaaaaaaaaaaaaaaaaa",
      saleId: null,
    }),
  });
  setMockModule("@/app/api/payment-intents/_lib/payment-intent-post-confirm", {
    runPostConfirmSideEffects: async () => {
      throw new Error("Twilio 503");
    },
  });
  setMockModule("@/app/api/integrations/mp/_lib/webhook-push", {
    pushOnConfirm: () => {},
  });

  const { POST } = require("@/app/api/internal/tasks/confirm-payment/route");
  const req = makeTaskRequest({
    oidcToken: "valid",
    queueName: "velora-payment-confirm",
    body: { paymentIntentId: "pi001aaaaaaaaaaaaaaaaaaa", businessId: "biz001" },
  });

  await assert.rejects(
    () => POST(req),
    /Twilio 503/,
    "side-effect error must propagate so Cloud Tasks retries for WPP delivery",
  );

  clearMockModules();
  resetSourceModules();
});
