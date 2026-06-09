// tests/vitest/api/pedidosya-adapter.test.ts
//
// Unit tests for PedidosYaAdapter in PEDIDOSYA_MOCK_MODE=true.
// Verifies the adapter satisfies the ProviderAdapter port contract:
//   - quote  returns a valid JsonRpcResponse with options[]
//   - create returns a valid JsonRpcResponse with trackingNumber
//   - track  returns a valid JsonRpcResponse with status + events[]
//
// No real network calls. PEDIDOSYA_API_TOKEN is not set so real paths are
// unreachable — mock guard fires first.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PedidosYaAdapter } from "@/app/api/agents/logistica/jsonrpc/_lib/providers/pedidosya-adapter";

// ── Helpers ───────────────────────────────────────────────────────────────────

const BUSINESS_ID = "test-business-pya-001";

interface JsonRpcResultBody {
  jsonrpc: "2.0";
  id: unknown;
  result: {
    kind: string;
    parts: Array<{ kind: string; text: string }>;
    result?: unknown;
  };
}

function asResult(r: unknown): JsonRpcResultBody {
  return r as JsonRpcResultBody;
}

function parseResultPayload(r: unknown): unknown {
  const body = asResult(r);
  const text = body.result?.parts?.[0]?.text;
  if (typeof text !== "string") throw new Error("parts[0].text missing");
  return JSON.parse(text) as unknown;
}

// ── Mock-mode setup ───────────────────────────────────────────────────────────

beforeAll(() => {
  process.env.PEDIDOSYA_MOCK_MODE = "true";
  // NODE_ENV is read-only in strict TS; tests already run with NODE_ENV=test
  // so the mock guard will not throw (fail-closed only in NODE_ENV=production).
});

afterAll(() => {
  delete process.env.PEDIDOSYA_MOCK_MODE;
});

// ── quote ─────────────────────────────────────────────────────────────────────

describe("PedidosYaAdapter.quote (mock mode)", () => {
  const adapter = new PedidosYaAdapter();

  it("returns a valid JsonRpcResponse (no error key)", async () => {
    const resp = await adapter.quote(
      { originPostalCode: "5500", destinationPostalCode: "1001", weightGrams: 500 },
      BUSINESS_ID,
    );
    expect(resp).not.toHaveProperty("error");
    expect(resp).toHaveProperty("result");
  });

  it("result.parts[0].text is parseable JSON", async () => {
    const resp = await adapter.quote(
      { originPostalCode: "5500", destinationPostalCode: "1001", weightGrams: 500 },
      BUSINESS_ID,
    );
    expect(() => parseResultPayload(resp)).not.toThrow();
  });

  it("returns options array with at least one entry", async () => {
    const resp = await adapter.quote(
      { originPostalCode: "5500", destinationPostalCode: "1001", weightGrams: 500 },
      BUSINESS_ID,
    );
    const payload = parseResultPayload(resp) as { options: unknown[] };
    expect(Array.isArray(payload.options)).toBe(true);
    expect(payload.options.length).toBeGreaterThan(0);
  });

  it("each option has service, serviceLabel, priceARS, estimatedDays", async () => {
    const resp = await adapter.quote(
      { originPostalCode: "5500", destinationPostalCode: "1001", weightGrams: 800 },
      BUSINESS_ID,
    );
    const payload = parseResultPayload(resp) as {
      options: Array<{ service: string; serviceLabel: string; priceARS: number; estimatedDays: number }>;
    };
    for (const opt of payload.options) {
      expect(typeof opt.service).toBe("string");
      expect(typeof opt.serviceLabel).toBe("string");
      expect(typeof opt.priceARS).toBe("number");
      expect(opt.priceARS).toBeGreaterThan(0);
      expect(typeof opt.estimatedDays).toBe("number");
    }
  });

  it("provider field is 'pedidosya'", async () => {
    const resp = await adapter.quote(
      { originPostalCode: "5500", destinationPostalCode: "1001", weightGrams: 500 },
      BUSINESS_ID,
    );
    const payload = parseResultPayload(resp) as { provider: string };
    expect(payload.provider).toBe("pedidosya");
  });
});

// ── create ────────────────────────────────────────────────────────────────────

describe("PedidosYaAdapter.create (mock mode)", () => {
  const adapter = new PedidosYaAdapter();

  it("returns a valid JsonRpcResponse (no error key)", async () => {
    const resp = await adapter.create(
      { saleId: "sale-pya-001", weightGrams: 500 },
      BUSINESS_ID,
    );
    expect(resp).not.toHaveProperty("error");
    expect(resp).toHaveProperty("result");
  });

  it("result includes trackingNumber and orderId", async () => {
    const resp = await adapter.create(
      { saleId: "sale-pya-002", weightGrams: 500 },
      BUSINESS_ID,
    );
    const payload = parseResultPayload(resp) as { trackingNumber: string; orderId: string };
    expect(typeof payload.trackingNumber).toBe("string");
    expect(payload.trackingNumber.length).toBeGreaterThan(0);
    expect(typeof payload.orderId).toBe("string");
  });

  it("trackingNumber starts with PYA- prefix (mock sentinel)", async () => {
    const resp = await adapter.create(
      { saleId: "sale-pya-003", weightGrams: 500 },
      BUSINESS_ID,
    );
    const payload = parseResultPayload(resp) as { trackingNumber: string };
    expect(payload.trackingNumber).toMatch(/^PYA-/);
  });

  it("labelUrl is null (v3 does not provide PDF labels)", async () => {
    const resp = await adapter.create(
      { saleId: "sale-pya-004", weightGrams: 500 },
      BUSINESS_ID,
    );
    const payload = parseResultPayload(resp) as { labelUrl: unknown };
    expect(payload.labelUrl).toBeNull();
  });

  it("returns JSON-RPC error when saleId is missing", async () => {
    const resp = await adapter.create({ weightGrams: 500 }, BUSINESS_ID);
    expect(resp).toHaveProperty("error");
    const r = resp as { error: { code: number; message: string } };
    expect(r.error.code).toBe(-32602);
    expect(r.error.message).toMatch(/saleId/i);
  });
});

// ── track ─────────────────────────────────────────────────────────────────────

describe("PedidosYaAdapter.track (mock mode)", () => {
  const adapter = new PedidosYaAdapter();

  it("returns a valid JsonRpcResponse (no error key)", async () => {
    const resp = await adapter.track(
      { trackingNumber: "PYA-12345-ABCDEF" },
      BUSINESS_ID,
    );
    expect(resp).not.toHaveProperty("error");
    expect(resp).toHaveProperty("result");
  });

  it("result includes trackingNumber, status, and events array", async () => {
    const resp = await adapter.track(
      { trackingNumber: "PYA-12345-ABCDEF" },
      BUSINESS_ID,
    );
    const payload = parseResultPayload(resp) as {
      trackingNumber: string;
      status: string;
      events: unknown[];
    };
    expect(payload.trackingNumber).toBe("PYA-12345-ABCDEF");
    expect(typeof payload.status).toBe("string");
    expect(Array.isArray(payload.events)).toBe(true);
    expect(payload.events.length).toBeGreaterThan(0);
  });

  it("events have timestamp and description fields", async () => {
    const resp = await adapter.track(
      { trackingNumber: "PYA-00000-TEST" },
      BUSINESS_ID,
    );
    const payload = parseResultPayload(resp) as {
      events: Array<{ timestamp: string; description: string }>;
    };
    for (const ev of payload.events) {
      expect(typeof ev.timestamp).toBe("string");
      expect(typeof ev.description).toBe("string");
    }
  });

  it("returns JSON-RPC error when trackingNumber is missing", async () => {
    const resp = await adapter.track({}, BUSINESS_ID);
    expect(resp).toHaveProperty("error");
    const r = resp as { error: { code: number; message: string } };
    expect(r.error.code).toBe(-32602);
    expect(r.error.message).toMatch(/trackingNumber/i);
  });
});
