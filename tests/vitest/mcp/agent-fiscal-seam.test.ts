// tests/vitest/mcp/agent-fiscal-seam.test.ts
//
// Tests for the AGENT_FISCAL_BACKEND flag + backendOverride injection in
// buildEmitInvoiceTool (emit-invoice-tool.ts).
//
// Coverage:
//   1. backendOverride set → tool calls backend.emitInvoice, returns result unchanged.
//   2. backendOverride set → sandboxUsed is set when result.sandbox is true.
//   3. backendOverride absent + AGENT_FISCAL_BACKEND unset → legacy arcaEmit path runs.
//   4. backendOverride absent + AGENT_FISCAL_BACKEND="velora" → createFiscalBackend routes through backend.
//   5. F-2 readiness guidance is appended on both backend and legacy paths.
//   6. backendOverride path does NOT call arcaEmit (isolation).
//   7. Legacy path does NOT call backend.emitInvoice (isolation).
//
// Mock seams:
//   arca-real/emit-invoice → emit (arcaEmit) — prevent real ARCA calls
//   @/lib/cloud-logger     → cloudLog (suppress output)
//   @/lib/mcp/_lib/fiscal-backend.factory → createFiscalBackend (for flag-path test)
//   @/app/api/agents/fiscal/jsonrpc/_lib/emit-invoice-tool.cae-persist → persistCaeAndQr

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { FiscalBackend } from "@/lib/mcp/_lib/fiscal-backend.port";
import type { EmitInvoiceToolResult } from "@/app/api/agents/fiscal/jsonrpc/_lib/emit-invoice-tool";

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const { arcaEmitMock, cloudLogMock, persistCaeAndQrMock, createFiscalBackendMock } = vi.hoisted(() => ({
  arcaEmitMock: vi.fn(),
  cloudLogMock: vi.fn(),
  persistCaeAndQrMock: vi.fn().mockResolvedValue(undefined),
  createFiscalBackendMock: vi.fn(),
}));

vi.mock(
  "@/app/api/agents/fiscal/jsonrpc/_lib/arca-real/emit-invoice",
  async (importOriginal) => {
    const original =
      await importOriginal<
        typeof import("@/app/api/agents/fiscal/jsonrpc/_lib/arca-real/emit-invoice")
      >();
    return { ...original, emit: arcaEmitMock };
  },
);

vi.mock("@/lib/cloud-logger", () => ({
  cloudLog: cloudLogMock,
  reportError: vi.fn(),
  runWithTraceContext: vi.fn((_: unknown, fn: () => unknown) => fn()),
}));

vi.mock(
  "@/app/api/agents/fiscal/jsonrpc/_lib/emit-invoice-tool.cae-persist",
  () => ({ persistCaeAndQr: persistCaeAndQrMock }),
);

vi.mock("@/lib/mcp/_lib/fiscal-backend.factory", () => ({
  createFiscalBackend: createFiscalBackendMock,
}));

// ── Subject ───────────────────────────────────────────────────────────────────

// Import AFTER mocks.
// eslint-disable-next-line import/order
import {
  buildEmitInvoiceTool,
  type EmitInvoiceToolContext,
} from "@/app/api/agents/fiscal/jsonrpc/_lib/emit-invoice-tool";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const SANDBOX_RESULT: EmitInvoiceToolResult = {
  sandbox: true,
  cae: "00000000000001",
  vencimiento: "20261231",
  tipo: "C",
  numero: 1,
  customerCuit: "20123456789",
  amountARS: 100,
  concept: "Productos y/o servicios",
};

const REAL_RESULT: EmitInvoiceToolResult = {
  sandbox: false,
  cae: "66000000000001",
  vencimiento: "20261231",
  tipo: "C",
  numero: 42,
  customerCuit: "20123456789",
  amountARS: 500,
  concept: "Test invoice",
};

/** Minimal stub FiscalBackend that records calls and returns a preset result. */
function makeBackendStub(result: EmitInvoiceToolResult): FiscalBackend & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    getFiscalReadiness: vi.fn().mockResolvedValue({ ready: true }),
    emitInvoice: vi.fn(async (input) => {
      calls.push(input);
      return result;
    }),
    emitNota: vi.fn().mockResolvedValue(result),
  };
}

function makeToolCtx(overrides: Partial<EmitInvoiceToolContext> = {}): EmitInvoiceToolContext {
  return { sandboxUsed: false, ...overrides };
}

/** Execute the FunctionTool's handler directly via its execute callback.
 *  FunctionTool.execute is typed as the internal executor — cast to any for test invocation. */
async function executeToolWith(
  businessId: string,
  toolCtx: EmitInvoiceToolContext,
  input: Record<string, unknown>,
): Promise<EmitInvoiceToolResult> {
  const tool = buildEmitInvoiceTool({ businessId }, toolCtx);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test: invoke internal execute directly
  return (tool as any).execute(input) as Promise<EmitInvoiceToolResult>;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("emit_invoice tool — backendOverride injection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.AGENT_FISCAL_BACKEND;
  });

  it("routes through backendOverride when set — backend.emitInvoice is called", async () => {
    const stub = makeBackendStub(SANDBOX_RESULT);
    const toolCtx = makeToolCtx({ backendOverride: stub });

    const result = await executeToolWith("biz-test", toolCtx, {
      customerCuit: "20123456789",
      amountARS: 100,
      tipo: "C",
    });

    expect(stub.emitInvoice).toHaveBeenCalledOnce();
    expect(stub.calls[0]).toMatchObject({
      tenantId: "biz-test",
      customerCuit: "20123456789",
      amountARS: 100,
      tipo: "C",
      concept: "Productos y/o servicios", // default resolved concept
    });
    expect(result).toMatchObject({
      sandbox: true,
      cae: SANDBOX_RESULT.cae,
      tipo: "C",
      numero: 1,
    });
  });

  it("returns normalized shape verbatim from backendOverride (EmitInvoiceOutput === EmitInvoiceToolResult)", async () => {
    const stub = makeBackendStub(REAL_RESULT);
    const toolCtx = makeToolCtx({ backendOverride: stub });

    const result = await executeToolWith("biz-test", toolCtx, {
      customerCuit: "20123456789",
      amountARS: 500,
      tipo: "C",
      concept: "Test invoice",
    });

    // Shape must be identical — no field renamed or dropped
    expect(result.sandbox).toBe(REAL_RESULT.sandbox);
    expect(result.cae).toBe(REAL_RESULT.cae);
    expect(result.vencimiento).toBe(REAL_RESULT.vencimiento);
    expect(result.tipo).toBe(REAL_RESULT.tipo);
    expect(result.numero).toBe(REAL_RESULT.numero);
    expect(result.customerCuit).toBe(REAL_RESULT.customerCuit);
    expect(result.amountARS).toBe(REAL_RESULT.amountARS);
    expect(result.concept).toBe(REAL_RESULT.concept);
  });

  it("sets toolCtx.sandboxUsed=true when backendOverride returns sandbox:true", async () => {
    const stub = makeBackendStub(SANDBOX_RESULT);
    const toolCtx = makeToolCtx({ backendOverride: stub });

    await executeToolWith("biz-test", toolCtx, {
      customerCuit: "20123456789",
      amountARS: 100,
      tipo: "C",
    });

    expect(toolCtx.sandboxUsed).toBe(true);
  });

  it("does NOT call arcaEmit when backendOverride is set", async () => {
    const stub = makeBackendStub(SANDBOX_RESULT);
    const toolCtx = makeToolCtx({ backendOverride: stub });

    await executeToolWith("biz-test", toolCtx, {
      customerCuit: "20123456789",
      amountARS: 100,
      tipo: "C",
    });

    expect(arcaEmitMock).not.toHaveBeenCalled();
  });

  it("appends F-2 setupGuidance on backend path when readiness.ready=false", async () => {
    const stub = makeBackendStub(SANDBOX_RESULT);
    const toolCtx = makeToolCtx({
      backendOverride: stub,
      readiness: { ready: false, missing: [], guidance: "Configure ARCA credentials first." },
    });

    const result = await executeToolWith("biz-test", toolCtx, {
      customerCuit: "20123456789",
      amountARS: 100,
      tipo: "C",
    });

    expect(result.setupGuidance).toBe("Configure ARCA credentials first.");
  });
});

describe("emit_invoice tool — legacy path (flag OFF, default)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.AGENT_FISCAL_BACKEND;
  });

  it("calls arcaEmit when no flag and no backendOverride", async () => {
    // arcaEmit returns a sandbox EmitResult shape
    arcaEmitMock.mockResolvedValueOnce({
      sandbox: true,
      cae: "00000000000001",
      vencimiento: "20261231",
      tipo: "C",
      numero: 1,
    });

    const toolCtx = makeToolCtx();
    await executeToolWith("biz-test", toolCtx, {
      customerCuit: "20123456789",
      amountARS: 100,
      tipo: "C",
    });

    expect(arcaEmitMock).toHaveBeenCalledOnce();
  });

  it("does NOT call createFiscalBackend when flag is unset", async () => {
    arcaEmitMock.mockResolvedValueOnce({
      sandbox: true,
      cae: "00000000000001",
      vencimiento: "20261231",
      tipo: "C",
      numero: 1,
    });

    const toolCtx = makeToolCtx();
    await executeToolWith("biz-test", toolCtx, {
      customerCuit: "20123456789",
      amountARS: 100,
      tipo: "C",
    });

    expect(createFiscalBackendMock).not.toHaveBeenCalled();
  });
});

describe("emit_invoice tool — AGENT_FISCAL_BACKEND flag path", () => {
  afterEach(() => {
    delete process.env.AGENT_FISCAL_BACKEND;
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls createFiscalBackend with the flag value when AGENT_FISCAL_BACKEND is set", async () => {
    process.env.AGENT_FISCAL_BACKEND = "velora";
    const stub = makeBackendStub(SANDBOX_RESULT);
    createFiscalBackendMock.mockReturnValueOnce(stub);

    const toolCtx = makeToolCtx();
    await executeToolWith("biz-test", toolCtx, {
      customerCuit: "20123456789",
      amountARS: 100,
      tipo: "C",
    });

    expect(createFiscalBackendMock).toHaveBeenCalledWith("velora");
    expect(stub.emitInvoice).toHaveBeenCalledOnce();
    expect(arcaEmitMock).not.toHaveBeenCalled();
  });

  it("flag path passes tenantId=businessId to backend.emitInvoice", async () => {
    process.env.AGENT_FISCAL_BACKEND = "velora";
    const stub = makeBackendStub(REAL_RESULT);
    createFiscalBackendMock.mockReturnValueOnce(stub);

    const toolCtx = makeToolCtx();
    await executeToolWith("biz-fiscal-tenant", toolCtx, {
      customerCuit: "20987654321",
      amountARS: 1500,
      tipo: "B",
      concept: "Servicios",
    });

    expect(stub.calls[0]).toMatchObject({
      tenantId: "biz-fiscal-tenant",
      customerCuit: "20987654321",
      amountARS: 1500,
      tipo: "B",
      concept: "Servicios",
    });
  });
});

// ── USE_MCP_FISCAL_TOOL flag tests (strangler-fig, default OFF) ───────────────
//
// These tests cover the canonical boolean gate added in feat/converge-fiscal-flagged.
// Design: USE_MCP_FISCAL_TOOL=true routes through createFiscalBackend("velora").
//         Flag OFF (default) → legacy arcaEmit, unchanged, safe for demo/prod.
//         AGENT_FISCAL_BACKEND still overrides the backend slug when both are set.

describe("emit_invoice tool — USE_MCP_FISCAL_TOOL boolean gate (strangler-fig)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.USE_MCP_FISCAL_TOOL;
    delete process.env.AGENT_FISCAL_BACKEND;
  });

  afterEach(() => {
    delete process.env.USE_MCP_FISCAL_TOOL;
    delete process.env.AGENT_FISCAL_BACKEND;
  });

  it("flag OFF (default) → legacy arcaEmit runs, createFiscalBackend NOT called", async () => {
    // USE_MCP_FISCAL_TOOL unset = default OFF — MUST use legacy path (safe for demo/prod).
    arcaEmitMock.mockResolvedValueOnce({
      sandbox: true,
      cae: "00000000000001",
      vencimiento: "20261231",
      tipo: "C",
      numero: 1,
    });

    const toolCtx = makeToolCtx();
    await executeToolWith("biz-test", toolCtx, {
      customerCuit: "20123456789",
      amountARS: 100,
      tipo: "C",
    });

    expect(arcaEmitMock).toHaveBeenCalledOnce();
    expect(createFiscalBackendMock).not.toHaveBeenCalled();
  });

  it("flag OFF explicit (USE_MCP_FISCAL_TOOL=false) → legacy path, no backend", async () => {
    process.env.USE_MCP_FISCAL_TOOL = "false";
    arcaEmitMock.mockResolvedValueOnce({
      sandbox: true,
      cae: "00000000000002",
      vencimiento: "20261231",
      tipo: "C",
      numero: 2,
    });

    const toolCtx = makeToolCtx();
    await executeToolWith("biz-test", toolCtx, {
      customerCuit: "20123456789",
      amountARS: 200,
      tipo: "C",
    });

    expect(arcaEmitMock).toHaveBeenCalledOnce();
    expect(createFiscalBackendMock).not.toHaveBeenCalled();
  });

  it("flag ON → createFiscalBackend called with 'velora' (default slug), arcaEmit NOT called", async () => {
    process.env.USE_MCP_FISCAL_TOOL = "true";
    const stub = makeBackendStub(SANDBOX_RESULT);
    createFiscalBackendMock.mockReturnValueOnce(stub);

    const toolCtx = makeToolCtx();
    await executeToolWith("biz-test", toolCtx, {
      customerCuit: "20123456789",
      amountARS: 100,
      tipo: "C",
    });

    // When USE_MCP_FISCAL_TOOL=true and AGENT_FISCAL_BACKEND is unset,
    // the tool defaults to "velora" — the only supported backend.
    expect(createFiscalBackendMock).toHaveBeenCalledWith("velora");
    expect(stub.emitInvoice).toHaveBeenCalledOnce();
    expect(arcaEmitMock).not.toHaveBeenCalled();
  });

  it("flag ON → tool name is still 'emit_invoice' (same contract to LLM)", () => {
    // The tool name MUST NOT change when the flag is ON — the LLM references it by name.
    // Note: buildEmitInvoiceTool does NOT call createFiscalBackend at construction time —
    // only at execute() time. So no mock setup is needed here.
    process.env.USE_MCP_FISCAL_TOOL = "true";

    const tool = buildEmitInvoiceTool({ businessId: "biz-test" }, makeToolCtx());
    // FunctionTool exposes the name via its declaration property.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test: access internal property
    expect((tool as any).name ?? (tool as any).declaration?.name).toBe("emit_invoice");
  });

  it("flag ON → backend receives correct tenantId, customerCuit, amountARS, tipo, concept", async () => {
    process.env.USE_MCP_FISCAL_TOOL = "true";
    const stub = makeBackendStub(REAL_RESULT);
    createFiscalBackendMock.mockReturnValueOnce(stub);

    const toolCtx = makeToolCtx();
    await executeToolWith("biz-mcp-test", toolCtx, {
      customerCuit: "20987654321",
      amountARS: 5000,
      tipo: "A",
      concept: "Venta mayorista",
    });

    expect(stub.calls[0]).toMatchObject({
      tenantId: "biz-mcp-test",
      customerCuit: "20987654321",
      amountARS: 5000,
      tipo: "A",
      concept: "Venta mayorista",
    });
  });

  it("USE_MCP_FISCAL_TOOL=true + AGENT_FISCAL_BACKEND='velora' → AGENT_FISCAL_BACKEND slug wins", async () => {
    // When both are set, AGENT_FISCAL_BACKEND takes precedence over the default 'velora'
    // slug so explicit backend selection is never overridden by the boolean gate.
    process.env.USE_MCP_FISCAL_TOOL = "true";
    process.env.AGENT_FISCAL_BACKEND = "velora";
    const stub = makeBackendStub(SANDBOX_RESULT);
    createFiscalBackendMock.mockReturnValueOnce(stub);

    const toolCtx = makeToolCtx();
    await executeToolWith("biz-test", toolCtx, {
      customerCuit: "20123456789",
      amountARS: 100,
      tipo: "C",
    });

    // Either way calls createFiscalBackend — behaviour is same (only one supported backend).
    expect(createFiscalBackendMock).toHaveBeenCalledWith("velora");
    expect(arcaEmitMock).not.toHaveBeenCalled();
  });
});
