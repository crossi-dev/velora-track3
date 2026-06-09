// tests/vitest/lib/email.test.ts — Unit tests for src/lib/email.ts
//
// Tests: success path, fail-closed when loader returns null, non-2xx response.
// fetch is mocked — no real HTTP calls.
// Credentials come from the per-business loader (BYOA); env vars are no longer used.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/cloud-logger", () => ({ cloudLog: vi.fn() }));

// Mock the credential loader — no DB/crypto involved in unit tests.
vi.mock("@/infrastructure/messaging/messaging-credential-loader", () => ({
  loadResendCredentials: vi.fn(),
}));

import { sendEmail } from "@/lib/email";
import { loadResendCredentials } from "@/infrastructure/messaging/messaging-credential-loader";

const TEST_BUSINESS_ID = "biz_test_001";

const VALID_CREDS = {
  apiKey: "re_test_key",
  from: "Velora <notificaciones@somosvelora.com>",
};

// ── fetch mock helpers ────────────────────────────────────────────────────────

function mockFetchOk(id: string) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ id }),
    text: async () => JSON.stringify({ id }),
  }));
}

function mockFetchError(status: number, statusText: string) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: false,
    status,
    statusText,
    text: async () => `{"message":"${statusText}"}`,
  }));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("sendEmail — success path", () => {
  beforeEach(() => {
    vi.mocked(loadResendCredentials).mockResolvedValue(VALID_CREDS);
    mockFetchOk("email-id-123");
  });
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("returns { ok: true, id } on 2xx response", async () => {
    const result = await sendEmail({ to: "test@example.com", subject: "Hi", text: "Hello" }, TEST_BUSINESS_ID);
    expect(result).toEqual({ ok: true, id: "email-id-123" });
  });

  it("calls Resend API endpoint with Authorization header", async () => {
    await sendEmail({ to: "test@example.com", subject: "Test", html: "<p>Hi</p>" }, TEST_BUSINESS_ID);
    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer re_test_key");
  });

  it("accepts html body", async () => {
    const result = await sendEmail({ to: "a@b.com", subject: "X", html: "<b>bold</b>" }, TEST_BUSINESS_ID);
    expect(result.ok).toBe(true);
  });

  it("accepts both html and text", async () => {
    const result = await sendEmail({ to: "a@b.com", subject: "X", html: "<b>bold</b>", text: "bold" }, TEST_BUSINESS_ID);
    expect(result.ok).toBe(true);
  });
});

describe("sendEmail — fail-closed when loader returns null (not configured)", () => {
  beforeEach(() => {
    vi.mocked(loadResendCredentials).mockResolvedValue(null);
    // fetch should NOT be called — stub to detect accidental calls.
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("fetch should not be called")));
  });
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("returns { ok: false, error } without throwing", async () => {
    const result = await sendEmail({ to: "test@example.com", subject: "Hi", text: "Hello" }, TEST_BUSINESS_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Email no configurado");
      expect(result.error).toContain("Resend");
    }
  });

  it("does NOT call fetch when credentials are absent", async () => {
    await sendEmail({ to: "test@example.com", subject: "Hi", text: "Hello" }, TEST_BUSINESS_ID);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("calls the loader with the provided businessId", async () => {
    await sendEmail({ to: "test@example.com", subject: "Hi", text: "Hello" }, TEST_BUSINESS_ID);
    expect(loadResendCredentials).toHaveBeenCalledWith(TEST_BUSINESS_ID);
  });
});

describe("sendEmail — non-2xx Resend response", () => {
  beforeEach(() => {
    vi.mocked(loadResendCredentials).mockResolvedValue(VALID_CREDS);
    mockFetchError(422, "Unprocessable Entity");
  });
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("returns { ok: false, error } on 4xx", async () => {
    const result = await sendEmail({ to: "bad@", subject: "Hi", text: "Hello" }, TEST_BUSINESS_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("422");
    }
  });

  it("does not throw on 5xx", async () => {
    mockFetchError(500, "Internal Server Error");
    const result = await sendEmail({ to: "test@example.com", subject: "Hi", text: "Hello" }, TEST_BUSINESS_ID);
    expect(result.ok).toBe(false);
  });
});
