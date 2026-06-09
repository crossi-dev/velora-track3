// tests/vitest/api/comm-messaging-dedup.test.ts
//
// Asserts that handleSms, handleEmail, handleOwnerPush, and handleEmployeePush
// call their respective facades ONLY ONCE when invoked twice with the SAME
// idempotency seed (supervisor retry scenario).
//
// The second call must be deduplicated by beginIdempotentMutation (kind != "execute")
// and the facade must NOT be called a second time.
//
// Dedup mechanism: beginIdempotentMutation inserts an IdempotencyRecord row on the
// first call and returns { kind: "execute" }. On the second call with the same derived
// key the unique index (businessId, actionType, idempotencyKey) fires a P2002 →
// beginIdempotentMutation returns { kind: "replay" | "conflict" | "in_flight" } →
// handler returns early WITHOUT calling the send facade.
//
// C-1 coverage: SMS/email handlers now take customerId (not raw `to`). The DB lookup
// for phone/email is mocked on the prisma.customer stub.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks (hoisted before module resolution) ──────────────────────────────────

vi.mock("@/lib/cloud-logger", () => ({ cloudLog: vi.fn(), reportWarning: vi.fn() }));

const { mockSendSms, mockSendEmail, mockSendPushToOwner, mockSendPushToEmployee } = vi.hoisted(() => ({
  mockSendSms: vi.fn(),
  mockSendEmail: vi.fn(),
  mockSendPushToOwner: vi.fn(),
  mockSendPushToEmployee: vi.fn(),
}));

vi.mock("@/lib/sms", () => ({ sendSms: mockSendSms }));
vi.mock("@/lib/email", () => ({ sendEmail: mockSendEmail }));
vi.mock("@/app/api/_lib/owner-push", () => ({ sendPushToOwner: mockSendPushToOwner }));
vi.mock("@/app/api/_lib/employee-push", () => ({ sendPushToEmployee: mockSendPushToEmployee }));
vi.mock("@/app/api/_lib/post-commit-failure-tracker", () => ({ recordPostCommitFailure: vi.fn() }));

// Idempotency mock: first call → "execute"; subsequent same-key calls → "replay".
// The map key is `${businessId}|${actionType}|${idempotencyKey}`.
const idempotencyState = new Map<string, string>();

vi.mock("@/app/api/_lib/idempotency", () => ({
  beginIdempotentMutation: vi.fn(
    async (args: { businessId: string; actionType: string; idempotencyKey: string }) => {
      const key = `${args.businessId}|${args.actionType}|${args.idempotencyKey}`;
      if (idempotencyState.has(key)) {
        return { kind: "replay" as const, response: {} };
      }
      idempotencyState.set(key, "pending");
      return { kind: "execute" as const, recordId: `rec-${key}` };
    },
  ),
  completeIdempotentMutation: vi.fn(async () => {}),
  releaseIdempotentMutation: vi.fn(async () => {}),
}));

// Prisma stub: customer.findFirst returns a record with phone + email.
vi.mock("@/lib/prisma", () => ({
  prisma: {
    customer: {
      findFirst: vi.fn().mockResolvedValue({
        phone: "+5491151234567",
        email: "user@example.com",
      }),
    },
    idempotencyRecord: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    chatMessage: {
      create: vi.fn().mockResolvedValue({}),
    },
  },
}));

// ── Imports under test ────────────────────────────────────────────────────────

import { handleSms, handleEmail } from "@/app/api/supervisor/_lib/communications-actions-messaging";
import { handleOwnerPush, handleEmployeePush } from "@/app/api/supervisor/_lib/communications-actions-push";

// ── Constants ─────────────────────────────────────────────────────────────────

const BUSINESS_ID = "biz-dedup-001";
const CUSTOMER_ID = "cust-dedup-001";
const EMPLOYEE_ID = "emp-dedup-001";
const SEED = "supervisor-turn-abc123";

// ── handleSms ─────────────────────────────────────────────────────────────────

describe("handleSms — idempotency dedup (C-1: customerId-based)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    idempotencyState.clear();
    mockSendSms.mockResolvedValue({ ok: true, sid: "SM_abc" });
  });

  it("calls sendSms exactly ONCE when handleSms is invoked twice with the same seed", async () => {
    const payload = { businessId: BUSINESS_ID, customerId: CUSTOMER_ID, body: "Hello" };

    await handleSms(payload, SEED);
    await handleSms(payload, SEED);

    expect(mockSendSms).toHaveBeenCalledTimes(1);
  });

  it("first call succeeds; second call is silently skipped (no error thrown)", async () => {
    const payload = { businessId: BUSINESS_ID, customerId: CUSTOMER_ID, body: "Hello" };

    await expect(handleSms(payload, SEED)).resolves.toBeUndefined();
    await expect(handleSms(payload, SEED)).resolves.toBeUndefined();
  });
});

// ── handleEmail ───────────────────────────────────────────────────────────────

describe("handleEmail — idempotency dedup (C-1: customerId-based)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    idempotencyState.clear();
    mockSendEmail.mockResolvedValue({ ok: true, id: "email-xyz" });
  });

  it("calls sendEmail exactly ONCE when handleEmail is invoked twice with the same seed", async () => {
    const payload = { businessId: BUSINESS_ID, customerId: CUSTOMER_ID, subject: "Hello", text: "World" };

    await handleEmail(payload, SEED);
    await handleEmail(payload, SEED);

    expect(mockSendEmail).toHaveBeenCalledTimes(1);
  });

  it("first call succeeds; second call is silently skipped (no error thrown)", async () => {
    const payload = { businessId: BUSINESS_ID, customerId: CUSTOMER_ID, subject: "Hello", text: "World" };

    await expect(handleEmail(payload, SEED)).resolves.toBeUndefined();
    await expect(handleEmail(payload, SEED)).resolves.toBeUndefined();
  });
});

// ── handleOwnerPush ───────────────────────────────────────────────────────────

describe("handleOwnerPush — idempotency dedup (H-2 fix)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    idempotencyState.clear();
    mockSendPushToOwner.mockResolvedValue({ attempted: 1, sent: 1, expired: 0 });
  });

  it("calls sendPushToOwner exactly ONCE when invoked twice with the same seed", async () => {
    const payload = { businessId: BUSINESS_ID, title: "Low stock", body: "Producto X bajo" };

    await handleOwnerPush(payload, SEED);
    await handleOwnerPush(payload, SEED);

    expect(mockSendPushToOwner).toHaveBeenCalledTimes(1);
  });

  it("first call succeeds; second call is silently skipped (no error thrown)", async () => {
    const payload = { businessId: BUSINESS_ID, title: "Low stock", body: "Producto X bajo" };

    await expect(handleOwnerPush(payload, SEED)).resolves.toBeUndefined();
    await expect(handleOwnerPush(payload, SEED)).resolves.toBeUndefined();
  });
});

// ── handleEmployeePush ────────────────────────────────────────────────────────

describe("handleEmployeePush — idempotency dedup (H-2 fix)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    idempotencyState.clear();
    mockSendPushToEmployee.mockResolvedValue(undefined);
  });

  it("calls sendPushToEmployee exactly ONCE when invoked twice with the same seed", async () => {
    const payload = {
      businessId: BUSINESS_ID,
      employeeId: EMPLOYEE_ID,
      title: "Recordatorio",
      body: "Turno en 10 min",
    };

    await handleEmployeePush(payload, SEED);
    await handleEmployeePush(payload, SEED);

    expect(mockSendPushToEmployee).toHaveBeenCalledTimes(1);
  });

  it("first call succeeds; second call is silently skipped (no error thrown)", async () => {
    const payload = {
      businessId: BUSINESS_ID,
      employeeId: EMPLOYEE_ID,
      title: "Recordatorio",
      body: "Turno en 10 min",
    };

    await expect(handleEmployeePush(payload, SEED)).resolves.toBeUndefined();
    await expect(handleEmployeePush(payload, SEED)).resolves.toBeUndefined();
  });
});

// ── recipientDedupKey ─────────────────────────────────────────────────────────

import { recipientDedupKey, executeCommunicationsActions } from "@/app/api/supervisor/_lib/communications-actions";

describe("recipientDedupKey — key derivation", () => {
  it("send_owner_push uses businessId as recipient", () => {
    const key = recipientDedupKey("send_owner_push", { businessId: "biz-A", title: "X", body: "Y" });
    expect(key).toBe("send_owner_push|biz-A");
  });

  it("write_owner_chat_message uses businessId as recipient", () => {
    const key = recipientDedupKey("write_owner_chat_message", { businessId: "biz-A", text: "hello", kind: "info" });
    expect(key).toBe("write_owner_chat_message|biz-A");
  });

  it("send_employee_push uses employeeId as recipient", () => {
    const keyX = recipientDedupKey("send_employee_push", { businessId: "biz-A", employeeId: "emp-X", title: "T", body: "B" });
    const keyY = recipientDedupKey("send_employee_push", { businessId: "biz-A", employeeId: "emp-Y", title: "T", body: "B" });
    expect(keyX).toBe("send_employee_push|emp-X");
    expect(keyY).toBe("send_employee_push|emp-Y");
    // Different employees → different keys → both must fire.
    expect(keyX).not.toBe(keyY);
  });

  it("send_sms uses customerId as recipient", () => {
    const key = recipientDedupKey("send_sms", { businessId: "biz-A", customerId: "cust-1", body: "Hi" });
    expect(key).toBe("send_sms|cust-1");
  });

  it("send_email uses customerId as recipient", () => {
    const key = recipientDedupKey("send_email", { businessId: "biz-A", customerId: "cust-2", subject: "S", text: "T" });
    expect(key).toBe("send_email|cust-2");
  });

  it("non-object data produces a stable fallback key with no recipient", () => {
    expect(recipientDedupKey("send_owner_push", null)).toBe("send_owner_push|");
    expect(recipientDedupKey("send_owner_push", "bad")).toBe("send_owner_push|");
  });
});

// ── executeCommunicationsActions — recipient-dedup (direct+delegated dual-emit) ──

describe("executeCommunicationsActions — recipient-dedup prevents dual-emit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    idempotencyState.clear();
    mockSendPushToOwner.mockResolvedValue({ attempted: 1, sent: 1, expired: 0 });
    mockSendPushToEmployee.mockResolvedValue(undefined);
  });

  it("two send_owner_push with same businessId but DIFFERENT data → handler called ONCE", async () => {
    // Simulates: Supervisor LLM emits send_owner_push directly (data_A) AND
    // call_communications_agent also returns send_owner_push (data_B, different wording).
    // Both share the same businessId → same recipient → only the FIRST must fire.
    const actions = [
      {
        intent: "send_owner_push",
        data: { businessId: BUSINESS_ID, title: "Stock bajo", body: "Producto X por debajo del mínimo" },
      },
      {
        intent: "send_owner_push",
        data: { businessId: BUSINESS_ID, title: "Alerta stock", body: "El stock de Producto X está bajo" },
      },
    ];

    await executeCommunicationsActions(actions, SEED, BUSINESS_ID);

    // Only one push must have fired despite two distinct payloads.
    expect(mockSendPushToOwner).toHaveBeenCalledTimes(1);
  });

  it("two send_employee_push to DIFFERENT employees → handler called TWICE", async () => {
    // Different employeeId → different recipient key → both must fire.
    const actions = [
      {
        intent: "send_employee_push",
        data: { businessId: BUSINESS_ID, employeeId: "emp-X", title: "Turno", body: "En 10 min" },
      },
      {
        intent: "send_employee_push",
        data: { businessId: BUSINESS_ID, employeeId: "emp-Y", title: "Turno", body: "En 10 min" },
      },
    ];

    await executeCommunicationsActions(actions, SEED, BUSINESS_ID);

    expect(mockSendPushToEmployee).toHaveBeenCalledTimes(2);
  });

  it("two send_employee_push to the SAME employee → handler called ONCE", async () => {
    // Same employeeId → same recipient key → only the first fires.
    const actions = [
      {
        intent: "send_employee_push",
        data: { businessId: BUSINESS_ID, employeeId: "emp-X", title: "Turno", body: "En 10 min" },
      },
      {
        intent: "send_employee_push",
        data: { businessId: BUSINESS_ID, employeeId: "emp-X", title: "Turno ahora", body: "Empezá ahora" },
      },
    ];

    await executeCommunicationsActions(actions, SEED, BUSINESS_ID);

    expect(mockSendPushToEmployee).toHaveBeenCalledTimes(1);
  });

  it("handled count reflects deduplicated (non-dropped) actions only", async () => {
    const actions = [
      { intent: "send_owner_push", data: { businessId: BUSINESS_ID, title: "A", body: "First" } },
      { intent: "send_owner_push", data: { businessId: BUSINESS_ID, title: "B", body: "Duplicate" } },
    ];

    const result = await executeCommunicationsActions(actions, SEED, BUSINESS_ID);

    // handled reflects only the deduplicated set (1), not the raw input (2).
    expect(result.handled).toBe(1);
  });
});
