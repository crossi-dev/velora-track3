// tests/vitest/mcp/fiscal-seam-cae-writeback.test.ts
//
// Verifies that the BACKEND (ON) path of emit_invoice persists CAE equivalently
// to the legacy path, and that the replay path does NOT double-persist.
//
// Coverage:
//   1. ON-path, real result, invoiceId present → persistCaeAndQr called once.
//   2. ON-path, real result, invoiceId absent → persistCaeAndQr NOT called.
//   3. ON-path, sandbox result → persistCaeAndQr NOT called (no legal CAE).
//   4. ON-path, replayed:true → persistCaeAndQr NOT called (already persisted).
//   5. ON-path, _raw absent → persistCaeAndQr NOT called (guard).
//   6. OFF-path (legacy, flag unset) → persistCaeAndQr NOT called by backend path.

import { describe, it, expect, vi, beforeEach } from "vitest";
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

// ── Subject (import after mocks) ──────────────────────────────────────────────

// eslint-disable-next-line import/order
import {
  buildEmitInvoiceTool,
  type EmitInvoiceToolContext,
} from "@/app/api/agents/fiscal/jsonrpc/_lib/emit-invoice-tool";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const REAL_RESULT: EmitInvoiceToolResult & { _raw?: { tipoComprobante: number; puntoVenta: number }; replayed?: true } = {
  sandbox: false,
  cae: "66000000000001",
  vencimiento: "20261231",
  tipo: "B",
  numero: 42,
  customerCuit: "20123456789",
  amountARS: 500,
  concept: "Test invoice",
  _raw: { tipoComprobante: 6, puntoVenta: 1 },
};

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

function makeBackendStub(
  result: EmitInvoiceToolResult & { _raw?: { tipoComprobante: number; puntoVenta: number }; replayed?: true },
): FiscalBackend {
  return {
    getFiscalReadiness: vi.fn().mockResolvedValue({ ready: true }),
    emitInvoice: vi.fn().mockResolvedValue(result),
    emitNota: vi.fn().mockResolvedValue(result),
  };
}

function makeToolCtx(overrides: Partial<EmitInvoiceToolContext> = {}): EmitInvoiceToolContext {
  return { sandboxUsed: false, ...overrides };
}

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

describe("fiscal seam — BACKEND path CAE writeback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.AGENT_FISCAL_BACKEND;
  });

  it("ON-path: calls persistCaeAndQr when real result + invoiceId present", async () => {
    const stub = makeBackendStub(REAL_RESULT);
    const toolCtx = makeToolCtx({
      backendOverride: stub,
      invoiceId: "inv-001",
      businessCuit: "20111222333",
      invoiceDate: "2026-06-02",
    });

    await executeToolWith("biz-test", toolCtx, {
      customerCuit: "20123456789",
      amountARS: 500,
      tipo: "B",
      concept: "Test invoice",
    });

    expect(persistCaeAndQrMock).toHaveBeenCalledOnce();
    expect(persistCaeAndQrMock).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "biz-test",
        invoiceId: "inv-001",
        resultCae: REAL_RESULT.cae,
        resultNumero: REAL_RESULT.numero,
      }),
    );
  });

  it("ON-path: does NOT call persistCaeAndQr when invoiceId is absent", async () => {
    const stub = makeBackendStub(REAL_RESULT);
    const toolCtx = makeToolCtx({ backendOverride: stub }); // no invoiceId

    await executeToolWith("biz-test", toolCtx, {
      customerCuit: "20123456789",
      amountARS: 500,
      tipo: "B",
    });

    expect(persistCaeAndQrMock).not.toHaveBeenCalled();
  });

  it("ON-path: does NOT call persistCaeAndQr for sandbox result (no legal CAE)", async () => {
    const stub = makeBackendStub(SANDBOX_RESULT);
    const toolCtx = makeToolCtx({
      backendOverride: stub,
      invoiceId: "inv-002",
    });

    await executeToolWith("biz-test", toolCtx, {
      customerCuit: "20123456789",
      amountARS: 100,
      tipo: "C",
    });

    expect(persistCaeAndQrMock).not.toHaveBeenCalled();
  });

  it("ON-path replay: does NOT call persistCaeAndQr when backend returns replayed:true", async () => {
    const replayResult: EmitInvoiceToolResult & { replayed: true; _raw?: { tipoComprobante: number; puntoVenta: number } } = {
      ...REAL_RESULT,
      replayed: true,
    };
    const stub = makeBackendStub(replayResult);
    const toolCtx = makeToolCtx({
      backendOverride: stub,
      invoiceId: "inv-003",
      businessCuit: "20111222333",
    });

    await executeToolWith("biz-test", toolCtx, {
      customerCuit: "20123456789",
      amountARS: 500,
      tipo: "B",
    });

    // Replay = CAE was persisted on first emit; must not double-persist.
    expect(persistCaeAndQrMock).not.toHaveBeenCalled();
  });

  it("ON-path: does NOT call persistCaeAndQr when _raw is absent (guard)", async () => {
    const resultWithoutRaw: EmitInvoiceToolResult = { ...REAL_RESULT };
    delete (resultWithoutRaw as EmitInvoiceToolResult & { _raw?: unknown })._raw;
    const stub = makeBackendStub(resultWithoutRaw);
    const toolCtx = makeToolCtx({
      backendOverride: stub,
      invoiceId: "inv-004",
    });

    await executeToolWith("biz-test", toolCtx, {
      customerCuit: "20123456789",
      amountARS: 500,
      tipo: "B",
    });

    expect(persistCaeAndQrMock).not.toHaveBeenCalled();
  });

  it("OFF-path: legacy arcaEmit path is byte-for-byte unchanged (no backend call)", async () => {
    // Flag unset + no backendOverride → legacy path.
    arcaEmitMock.mockResolvedValueOnce({
      sandbox: true,
      cae: "00000000000001",
      vencimiento: "20261231",
      tipo: "C",
      numero: 1,
    });

    const toolCtx = makeToolCtx({ invoiceId: "inv-legacy" });
    await executeToolWith("biz-test", toolCtx, {
      customerCuit: "20123456789",
      amountARS: 100,
      tipo: "C",
    });

    expect(arcaEmitMock).toHaveBeenCalledOnce();
    expect(createFiscalBackendMock).not.toHaveBeenCalled();
    // sandbox result → persistCaeAndQr not called (existing legacy behaviour)
    expect(persistCaeAndQrMock).not.toHaveBeenCalled();
  });
});
