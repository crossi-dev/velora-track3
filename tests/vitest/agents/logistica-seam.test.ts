// tests/vitest/agents/logistica-seam.test.ts
//
// Seam tests for the AGENT_LOGISTICA_BACKEND flag on the three remaining
// logistica agent tools: compare_rates, create_shipment, track_shipment.
//
// Each test verifies two scenarios:
//   SEAM ON  — backendOverride stub is called and legacy prisma mocks are NOT called.
//   SEAM OFF — no backendOverride + AGENT_LOGISTICA_BACKEND unset → legacy path used.
//
// Tool-layer logic (adapter.quote/create/track, dedup check) is NOT re-tested here —
// it is already covered by tests/vitest/mcp/logistica-tools.test.ts and
// tests/vitest/agents/package-profile-tool.test.ts.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createCompareRatesTool } from "@/app/api/agents/logistica/jsonrpc/_lib/logistica-tools/rate-comparison-tool";
import { createCreateShipmentTool } from "@/app/api/agents/logistica/jsonrpc/_lib/logistica-tools/create-shipment-tool";
import { createTrackShipmentTool } from "@/app/api/agents/logistica/jsonrpc/_lib/logistica-tools/track-shipment-tool";
import type { LogisticaBackend } from "@/lib/mcp/_lib/logistica-backend.port";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const {
  prismaMock,
  getCourierEntryMock,
  COURIER_REGISTRY_MOCK,
  mockCourierAdapter,
} = vi.hoisted(() => {
  const adapter = {
    quote: vi.fn(),
    create: vi.fn(),
    track: vi.fn(),
  };
  const entry = { name: "andreani", active: true, getAdapter: () => adapter };
  return {
    prismaMock: {
      courierCredential: { findMany: vi.fn() },
      business: { findUnique: vi.fn() },
      andreaniShipment: { findFirst: vi.fn() },
      // PedidosYa BYOA gate (resolveActiveCouriers): default to no PedidosYa channel.
      businessChannelCredential: { findUnique: vi.fn().mockResolvedValue(null) },
    },
    getCourierEntryMock: vi.fn(),
    COURIER_REGISTRY_MOCK: [entry],
    mockCourierAdapter: adapter,
  };
});

vi.mock("@/app/api/agents/logistica/jsonrpc/_lib/courier-registry", () => ({
  COURIER_REGISTRY: COURIER_REGISTRY_MOCK,
  getCourierEntry: getCourierEntryMock,
  getActiveCourierNames: () => ["andreani"],
}));

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));

// ── Stub builder ──────────────────────────────────────────────────────────────

function makeBackendStub(overrides: Partial<LogisticaBackend> = {}): LogisticaBackend {
  return {
    resolveActiveCouriers: vi.fn().mockResolvedValue({ activeCouriers: [] }),
    getCourierEntryForCreate: vi.fn().mockResolvedValue({ courierEntry: undefined }),
    getCourierEntryForTrack: vi.fn().mockResolvedValue({ courierEntry: undefined }),
    getPackageProfile: vi.fn().mockResolvedValue({ weightGrams: 0, hasRealWeightData: false, itemCount: 0, breakdown: [] }),
    ...overrides,
  };
}

/** Invoke a FunctionTool's execute directly. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- accessing internal for unit test
async function exec(tool: unknown, args: unknown): Promise<unknown> {
  return (tool as any).execute(args);
}

const BIZ = "biz-seam-test-001";

// ── compare_rates seam ────────────────────────────────────────────────────────

describe("compare_rates seam (AGENT_LOGISTICA_BACKEND)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("SEAM ON: resolveActiveCouriers is called on the backend stub, legacy prisma NOT called", async () => {
    const stub = makeBackendStub({
      resolveActiveCouriers: vi.fn().mockResolvedValue({ activeCouriers: [] }),
    });
    const tool = createCompareRatesTool(BIZ, { backendOverride: stub });
    await exec(tool, {
      originPostalCode: "5500",
      destinationPostalCode: "1001",
      weightGrams: 1000,
      declaredValue: 0,
    });

    expect(stub.resolveActiveCouriers).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: BIZ, originPostalCode: "5500" }),
    );
    expect(prismaMock.courierCredential.findMany).not.toHaveBeenCalled();
    expect(prismaMock.business.findUnique).not.toHaveBeenCalled();
  });

  it("SEAM OFF: legacy resolveActiveCouriersLegacy uses prisma when no backendOverride and env unset", async () => {
    const savedEnv = process.env.AGENT_LOGISTICA_BACKEND;
    delete process.env.AGENT_LOGISTICA_BACKEND;

    prismaMock.courierCredential.findMany.mockResolvedValue([]);
    prismaMock.business.findUnique.mockResolvedValue({ courierPreference: null });

    const tool = createCompareRatesTool(BIZ, { backendOverride: null });
    await exec(tool, {
      originPostalCode: "5500",
      destinationPostalCode: "1001",
      weightGrams: 500,
      declaredValue: 0,
    });

    expect(prismaMock.courierCredential.findMany).toHaveBeenCalled();
    expect(prismaMock.business.findUnique).toHaveBeenCalled();

    if (savedEnv !== undefined) process.env.AGENT_LOGISTICA_BACKEND = savedEnv;
  });
});

// ── create_shipment seam ──────────────────────────────────────────────────────

describe("create_shipment seam (AGENT_LOGISTICA_BACKEND)", () => {
  const ARGS = {
    provider: "andreani",
    saleId: "sale-seam-001",
    customerName: "Ana",
    customerAddress: "Rivadavia",
    customerPostalCode: "5500",
    weightGrams: 800,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // Dedup check: no existing shipment.
    prismaMock.andreaniShipment.findFirst.mockResolvedValue(null);
  });

  it("SEAM ON: getCourierEntryForCreate is called on the backend stub, getCourierEntry NOT called", async () => {
    const stub = makeBackendStub({
      getCourierEntryForCreate: vi.fn().mockResolvedValue({ courierEntry: undefined }),
    });
    const tool = createCreateShipmentTool(BIZ, { backendOverride: stub });
    await exec(tool, ARGS);

    expect(stub.getCourierEntryForCreate).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: BIZ, provider: "andreani" }),
    );
    expect(getCourierEntryMock).not.toHaveBeenCalled();
  });

  it("SEAM OFF: getCourierEntry called directly when no backendOverride and env unset", async () => {
    const savedEnv = process.env.AGENT_LOGISTICA_BACKEND;
    delete process.env.AGENT_LOGISTICA_BACKEND;

    getCourierEntryMock.mockReturnValue(undefined); // unknown → error response

    const tool = createCreateShipmentTool(BIZ, { backendOverride: null });
    await exec(tool, ARGS);

    expect(getCourierEntryMock).toHaveBeenCalledWith("andreani");

    if (savedEnv !== undefined) process.env.AGENT_LOGISTICA_BACKEND = savedEnv;
  });

  it("SEAM ON: dedup check (prisma.andreaniShipment) still runs on backend path when courierEntry resolves", async () => {
    // The dedup check is tool-layer idempotency — must run after provider resolution.
    // Stub returns a real courierEntry so execution reaches the dedup check.
    const fakeEntry = { name: "andreani", active: true, getAdapter: () => mockCourierAdapter };
    prismaMock.andreaniShipment.findFirst.mockResolvedValue({
      trackingNumber: "AND-EXISTING-123",
    });

    const stub = makeBackendStub({
      getCourierEntryForCreate: vi.fn().mockResolvedValue({ courierEntry: fakeEntry }),
    });
    const tool = createCreateShipmentTool(BIZ, { backendOverride: stub });
    const result = await exec(tool, ARGS) as { alreadyExists?: boolean; trackingNumber?: string };

    // Backend resolved the entry; dedup then fires and short-circuits.
    expect(stub.getCourierEntryForCreate).toHaveBeenCalled();
    expect(prismaMock.andreaniShipment.findFirst).toHaveBeenCalled();
    expect(result.alreadyExists).toBe(true);
    expect(result.trackingNumber).toBe("AND-EXISTING-123");
  });
});

// ── track_shipment seam ───────────────────────────────────────────────────────

describe("track_shipment seam (AGENT_LOGISTICA_BACKEND)", () => {
  const ARGS = { provider: "andreani", trackingNumber: "AND-SEAM-999" };

  beforeEach(() => vi.clearAllMocks());

  it("SEAM ON: getCourierEntryForTrack is called on the backend stub, getCourierEntry NOT called", async () => {
    const stub = makeBackendStub({
      getCourierEntryForTrack: vi.fn().mockResolvedValue({ courierEntry: undefined }),
    });
    const tool = createTrackShipmentTool(BIZ, { backendOverride: stub });
    await exec(tool, ARGS);

    expect(stub.getCourierEntryForTrack).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: BIZ, provider: "andreani" }),
    );
    expect(getCourierEntryMock).not.toHaveBeenCalled();
  });

  it("SEAM OFF: getCourierEntry called directly when no backendOverride and env unset", async () => {
    const savedEnv = process.env.AGENT_LOGISTICA_BACKEND;
    delete process.env.AGENT_LOGISTICA_BACKEND;

    getCourierEntryMock.mockReturnValue(undefined); // unknown → error response

    const tool = createTrackShipmentTool(BIZ, { backendOverride: null });
    await exec(tool, ARGS);

    expect(getCourierEntryMock).toHaveBeenCalledWith("andreani");

    if (savedEnv !== undefined) process.env.AGENT_LOGISTICA_BACKEND = savedEnv;
  });
});
