// tests/vitest/lib/sms.test.ts — Unit tests for src/lib/sms.ts
//
// Tests: success path, fail-closed when loader returns null, phone normalised to E.164,
// non-2xx Twilio response.
// fetch is mocked — no real HTTP calls.
// Credentials come from the per-business loader (BYOA); env vars are no longer used.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/cloud-logger", () => ({ cloudLog: vi.fn() }));

// Mock the credential loader — no DB/crypto involved in unit tests.
vi.mock("@/infrastructure/messaging/messaging-credential-loader", () => ({
  loadTwilioSmsCredentials: vi.fn(),
}));

// normalizePhone in whatsapp-meta.ts imports whatsapp-twilio.ts which has a module-load
// IIFE that logs when VELORA_APP_URL is absent; mock the whole facade so we don't
// exercise the IIFE side-effect.
vi.mock("@/lib/whatsapp", () => ({
  normalizePhone: (phone: string) => {
    // Minimal E.164 normalisation — mirrors AR logic for tests.
    const digits = phone.replace(/\D/g, "");
    if (!digits) throw new Error("El teléfono debe contener al menos un dígito.");
    if (digits.startsWith("54")) {
      return digits[2] === "9" ? `+${digits}` : `+549${digits.slice(2)}`;
    }
    if (!phone.trim().startsWith("+")) {
      return digits.length === 11 && digits[0] === "9" ? `+54${digits}` : `+549${digits}`;
    }
    return `+${digits}`;
  },
}));

import { sendSms } from "@/lib/sms";
import { loadTwilioSmsCredentials } from "@/infrastructure/messaging/messaging-credential-loader";

const TEST_BUSINESS_ID = "biz_test_001";

const VALID_CREDS = {
  accountSid: "AC_test_sid",
  authToken: "test_auth_token",
  from: "+14155551234",
};

// ── fetch mock helpers ────────────────────────────────────────────────────────

function mockFetchOk(sid: string, status = "queued") {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ sid, status, error_code: null }),
  }));
}

function mockFetchError(httpStatus: number, statusText: string) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: false,
    status: httpStatus,
    statusText,
    text: async () => `{"message":"${statusText}"}`,
  }));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("sendSms — success path", () => {
  beforeEach(() => {
    vi.mocked(loadTwilioSmsCredentials).mockResolvedValue(VALID_CREDS);
    mockFetchOk("SM_abc123");
  });
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("returns { ok: true, sid } on 2xx response", async () => {
    const result = await sendSms({ to: "1100000000", body: "Hola" }, TEST_BUSINESS_ID);
    expect(result).toEqual({ ok: true, sid: "SM_abc123" });
  });

  it("calls Twilio Messages.json endpoint with Basic auth", async () => {
    await sendSms({ to: "1100000000", body: "Test" }, TEST_BUSINESS_ID);
    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("api.twilio.com");
    expect(url).toContain("Messages.json");
    // Basic auth = base64("AC_test_sid:test_auth_token")
    const expectedAuth = `Basic ${Buffer.from("AC_test_sid:test_auth_token").toString("base64")}`;
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(expectedAuth);
  });

  it("sends plain E.164 To without whatsapp: prefix", async () => {
    await sendSms({ to: "1100000000", body: "Test" }, TEST_BUSINESS_ID);
    const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const body = init.body as URLSearchParams;
    const params = new URLSearchParams(body.toString());
    expect(params.get("To")).toMatch(/^\+/);
    expect(params.get("To")).not.toContain("whatsapp:");
  });
});

describe("sendSms — phone number normalisation to E.164", () => {
  beforeEach(() => {
    vi.mocked(loadTwilioSmsCredentials).mockResolvedValue(VALID_CREDS);
    mockFetchOk("SM_norm");
  });
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("normalises local AR 10-digit number to E.164", async () => {
    await sendSms({ to: "1100000000", body: "Test" }, TEST_BUSINESS_ID);
    const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const params = new URLSearchParams((init.body as URLSearchParams).toString());
    // local AR 1100000000 → +5490000000000
    expect(params.get("To")).toMatch(/^\+549/);
  });

  it("passes international number through unchanged", async () => {
    await sendSms({ to: "+12025551234", body: "Test" }, TEST_BUSINESS_ID);
    const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const params = new URLSearchParams((init.body as URLSearchParams).toString());
    expect(params.get("To")).toBe("+12025551234");
  });
});

describe("sendSms — fail-closed when loader returns null (not configured)", () => {
  beforeEach(() => {
    vi.mocked(loadTwilioSmsCredentials).mockResolvedValue(null);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("fetch should not be called")));
  });
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("returns { ok: false, error } without throwing when credentials absent", async () => {
    const result = await sendSms({ to: "1100000000", body: "Test" }, TEST_BUSINESS_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("SMS no configurado");
      expect(result.error).toContain("Twilio");
    }
  });

  it("does NOT call fetch when credentials are absent", async () => {
    await sendSms({ to: "1100000000", body: "Test" }, TEST_BUSINESS_ID);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("calls the loader with the provided businessId", async () => {
    await sendSms({ to: "1100000000", body: "Test" }, TEST_BUSINESS_ID);
    expect(loadTwilioSmsCredentials).toHaveBeenCalledWith(TEST_BUSINESS_ID);
  });
});

describe("sendSms — non-2xx Twilio response", () => {
  beforeEach(() => {
    vi.mocked(loadTwilioSmsCredentials).mockResolvedValue(VALID_CREDS);
    mockFetchError(400, "Bad Request");
  });
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("returns { ok: false, error } on 4xx", async () => {
    const result = await sendSms({ to: "1100000000", body: "Test" }, TEST_BUSINESS_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("400");
  });

  it("does not throw on 5xx", async () => {
    mockFetchError(500, "Internal Server Error");
    const result = await sendSms({ to: "1100000000", body: "Test" }, TEST_BUSINESS_ID);
    expect(result.ok).toBe(false);
  });
});
