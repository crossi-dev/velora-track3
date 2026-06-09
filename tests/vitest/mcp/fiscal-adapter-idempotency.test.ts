// tests/vitest/mcp/fiscal-adapter-idempotency.test.ts
//
// Unit tests for the idempotency layer added to VeloraFiscalAdapter.
//
// Verified behaviors:
//   1. First call (execute path): emit() is called, result returned, idempotency record completed.
//   2. Second call with same inputs (replay path): stored result returned, emit() NOT called again.
//   3. in_flight: throws EMIT_IN_FLIGHT.
//   4. emit() throws (AFIP-level): idempotency record released, error rethrown.
//   5. CRITICAL: emit() succeeds but complete() throws: record is NOT released, error rethrown.
//   6. C-1: two calls for the SAME business, DIFFERENT puntoVenta → distinct keys, emit() called twice.
//   7. H-2: replay returns replayed:true marker on the stored result.
//   8. H-1: transport/timeout error → record NOT released; AFIP-level rejection → record released.
//   9. H-3: begin() returning "conflict" → single retry; "missing" → descriptive error.
//
// Mock seams (mirror fiscal-mcp-server.test.ts conventions):
//   @/lib/prisma                                           → prisma.business.findUnique + arcaCredential.findUnique
//   arca-real/emit-invoice                                 → emit
//   @/infrastructure/persistence/prisma-idempotency.adapter → prismaIdempotencyAdapter
//   @/lib/cloud-logger                                     → cloudLog (suppress output)

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const { prismaMock, emitMock, idempotencyMock, cloudLogMock } = vi.hoisted(() => ({
  prismaMock: {
    business: {
      findUnique: vi.fn().mockResolvedValue({ ivaCondition: "Monotributista" }),
    },
    arcaCredential: {
      // Default: no credential row → sandbox sentinel "0"
      findUnique: vi.fn().mockResolvedValue(null),
    },
  },

  emitMock: vi.fn(),

  // Idempotency adapter mock — controls the begin/complete/release contract.
  idempotencyMock: {
    begin: vi.fn(),
    complete: vi.fn().mockResolvedValue(undefined),
    release: vi.fn().mockResolvedValue(undefined),
  },

  cloudLogMock: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));

vi.mock(
  "@/app/api/agents/fiscal/jsonrpc/_lib/arca-real/emit-invoice",
  async (importOriginal) => {
    // Preserve pure exports (sandboxEmit, resolveInvoiceType, splitIva21)
    // exactly as in fiscal-mcp-server.test.ts — only replace emit().
    const original =
      await importOriginal<
        typeof import("@/app/api/agents/fiscal/jsonrpc/_lib/arca-real/emit-invoice")
      >();
    return { ...original, emit: emitMock };
  },
);

vi.mock("@/infrastructure/persistence/prisma-idempotency.adapter", () => ({
  prismaIdempotencyAdapter: idempotencyMock,
}));

vi.mock("@/lib/cloud-logger", () => ({ cloudLog: cloudLogMock }));

// ── Subject under test ────────────────────────────────────────────────────────

// Import AFTER mocks are registered.
// eslint-disable-next-line import/order
import { VeloraFiscalAdapter } from "@/lib/mcp/_lib/velora-fiscal.adapter";

// ── Shared fixtures ───────────────────────────────────────────────────────────

const TENANT_ID = "biz-idem-test";

const EMIT_INPUT = {
  tenantId: TENANT_ID,
  customerCuit: "20055361682",
  amountARS: 1500,
  tipo: "C" as const,
  concept: "Productos varios",
};

// What emit() returns (sandbox shape — normaliseEmitResult passes it through).
const EMIT_RESULT_RAW = {
  sandbox: true as const,
  cae: "12345678901234",
  vencimiento: "20260630",
  tipo: "C" as const,
  numero: 99,
  customerCuit: EMIT_INPUT.customerCuit,
  amountARS: EMIT_INPUT.amountARS,
  concept: EMIT_INPUT.concept,
};

// What VeloraFiscalAdapter.emitInvoice returns (normaliseEmitResult output).
// For sandbox, normaliseEmitResult is a pass-through of the same fields.
const EXPECTED_RESULT = {
  sandbox: true,
  cae: "12345678901234",
  vencimiento: "20260630",
  tipo: "C",
  numero: 99,
  customerCuit: EMIT_INPUT.customerCuit,
  amountARS: EMIT_INPUT.amountARS,
  concept: EMIT_INPUT.concept,
};

const RECORD_ID = "record-uuid-001";

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("VeloraFiscalAdapter.emitInvoice — idempotency layer", () => {
  let adapter: VeloraFiscalAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new VeloraFiscalAdapter();

    // Default prisma stubs.
    prismaMock.business.findUnique.mockResolvedValue({ ivaCondition: "Monotributista" });
    prismaMock.arcaCredential.findUnique.mockResolvedValue(null); // no credential → sandbox sentinel
    // Default emit stub.
    emitMock.mockResolvedValue(EMIT_RESULT_RAW);
    // Default idempotency stubs.
    idempotencyMock.complete.mockResolvedValue(undefined);
    idempotencyMock.release.mockResolvedValue(undefined);
  });

  // ── 1. First call (execute) ─────────────────────────────────────────────────

  it("first call: calls emit() exactly once and completes the idempotency record", async () => {
    idempotencyMock.begin.mockResolvedValue({ kind: "execute", recordId: RECORD_ID });

    const result = await adapter.emitInvoice(EMIT_INPUT);

    // emit() must have been called exactly once with the correct args.
    expect(emitMock).toHaveBeenCalledOnce();
    expect(emitMock).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: TENANT_ID,
        customerCuit: EMIT_INPUT.customerCuit,
        amountARS: EMIT_INPUT.amountARS,
        tipo: EMIT_INPUT.tipo,
        concept: EMIT_INPUT.concept,
        condicionIva: "Monotributista",
      }),
    );

    // Idempotency record must be completed with the result.
    expect(idempotencyMock.complete).toHaveBeenCalledOnce();
    expect(idempotencyMock.complete).toHaveBeenCalledWith(
      null,
      RECORD_ID,
      200,
      expect.objectContaining({ cae: EXPECTED_RESULT.cae, numero: EXPECTED_RESULT.numero }),
    );

    // release must NOT have been called.
    expect(idempotencyMock.release).not.toHaveBeenCalled();

    expect(result).toMatchObject(EXPECTED_RESULT);
  });

  // ── 2. Second call with same inputs (replay) ────────────────────────────────

  it("replay: returns stored result WITHOUT calling emit() again", async () => {
    // Simulate the idempotency layer returning a replay (second call).
    idempotencyMock.begin.mockResolvedValue({
      kind: "replay",
      status: 200,
      body: EXPECTED_RESULT,
    });

    const result = await adapter.emitInvoice(EMIT_INPUT);

    // The critical assertion: emit() must NOT have been called.
    expect(emitMock).not.toHaveBeenCalled();
    // complete and release must also not be called (no execute path taken).
    expect(idempotencyMock.complete).not.toHaveBeenCalled();
    expect(idempotencyMock.release).not.toHaveBeenCalled();

    // The stored result is returned verbatim.
    expect(result).toMatchObject(EXPECTED_RESULT);
  });

  // ── 3. in_flight ───────────────────────────────────────────────────────────

  it("in_flight: throws EMIT_IN_FLIGHT without calling emit()", async () => {
    idempotencyMock.begin.mockResolvedValue({ kind: "in_flight" });

    await expect(adapter.emitInvoice(EMIT_INPUT)).rejects.toThrow("EMIT_IN_FLIGHT");
    expect(emitMock).not.toHaveBeenCalled();
  });

  // ── 4. emit() throws (AFIP-level) → release ────────────────────────────────

  it("emit() throws an AFIP-level error: releases the idempotency record and rethrows", async () => {
    idempotencyMock.begin.mockResolvedValue({ kind: "execute", recordId: RECORD_ID });
    emitMock.mockRejectedValue(new Error("WSFE SOAP fault: error 10016 importe inválido"));

    await expect(adapter.emitInvoice(EMIT_INPUT)).rejects.toThrow("WSFE SOAP fault");

    // release must be called so the record does not stay stuck pending.
    expect(idempotencyMock.release).toHaveBeenCalledWith(RECORD_ID);
    // complete must NOT be called (emission failed).
    expect(idempotencyMock.complete).not.toHaveBeenCalled();
  });

  // ── 5. CRITICAL: emit() succeeds but complete() throws → NO release ────────

  it("CRITICAL: if emit() succeeds but complete() throws, record is NOT released", async () => {
    idempotencyMock.begin.mockResolvedValue({ kind: "execute", recordId: RECORD_ID });
    // emit() returns a valid CAE — AFIP number IS consumed.
    emitMock.mockResolvedValue(EMIT_RESULT_RAW);
    // complete() fails (e.g., transient DB error).
    idempotencyMock.complete.mockRejectedValue(new Error("DB write error"));

    await expect(adapter.emitInvoice(EMIT_INPUT)).rejects.toThrow("DB write error");

    // release must NOT be called: releasing would allow a retry to burn
    // another AFIP sequential number for an invoice that was already emitted.
    expect(idempotencyMock.release).not.toHaveBeenCalled();

    // A CRITICAL/FATAL log must have been emitted.
    expect(cloudLogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: "CRITICAL",
        action: "EMIT_IDEMPOTENCY_COMPLETE_FAILED",
      }),
    );
  });

  // ── 6. C-1: different puntoVenta → different keys, both emit() ────────────
  //
  // THE COMPLIANCE FIX: a business with two puntos de venta MUST produce two
  // distinct idempotency keys so the second emission is NOT replayed as the first.

  it("C-1: two emitInvoice calls for the same business but different puntoVenta produce DIFFERENT keys and both call emit()", async () => {
    // First call: puntoVenta = 1
    prismaMock.arcaCredential.findUnique.mockResolvedValueOnce({ puntoVenta: 1 });
    idempotencyMock.begin.mockResolvedValueOnce({ kind: "execute", recordId: "rec-pta-1" });
    emitMock.mockResolvedValueOnce({ ...EMIT_RESULT_RAW, numero: 1 });

    // Second call: puntoVenta = 2 (same businessId, same CUIT, same amount, same tipo)
    prismaMock.arcaCredential.findUnique.mockResolvedValueOnce({ puntoVenta: 2 });
    idempotencyMock.begin.mockResolvedValueOnce({ kind: "execute", recordId: "rec-pta-2" });
    emitMock.mockResolvedValueOnce({ ...EMIT_RESULT_RAW, numero: 2 });

    const adapterLocal = new VeloraFiscalAdapter();
    const result1 = await adapterLocal.emitInvoice(EMIT_INPUT);
    const result2 = await adapterLocal.emitInvoice(EMIT_INPUT);

    // Both calls must have reached emit() — neither is a replay of the other.
    expect(emitMock).toHaveBeenCalledTimes(2);

    // The two begin() calls must have used DIFFERENT idempotency keys.
    const key1 = idempotencyMock.begin.mock.calls[0]?.[0]?.idempotencyKey as string;
    const key2 = idempotencyMock.begin.mock.calls[1]?.[0]?.idempotencyKey as string;
    expect(key1).toBeDefined();
    expect(key2).toBeDefined();
    expect(key1).not.toEqual(key2);

    // Sanity: different results were returned for each call.
    expect((result1 as { numero?: number }).numero).toBe(1);
    expect((result2 as { numero?: number }).numero).toBe(2);
  });

  // ── M-3 (MEDIUM-3): tipo canonicalized before key — retry with corrected tipo → same key ─
  //
  // Scenario: Monotributista business. Agent emits tipo="B" (wrong — agent self-correction
  // lag). Adapter resolves condicionIva="Monotributista" → canonicalTipo="C" before hashing.
  // A retry where the agent already supplies tipo="C" (self-corrected) also resolves to "C"
  // → SAME key → idempotency replay → NO second AFIP emission.
  //
  // Anti-regression guard: a genuinely different invoice (different customerCuit) still gets
  // a different key even after canonicalization, so no false dedup occurs.

  it("M-3: agent emits tipo=B for Monotributista; retry with tipo=C → SAME idempotency key (no second emission)", async () => {
    // Both calls: Monotributista business, no credential (sandbox sentinel puntoVenta="0").
    prismaMock.business.findUnique.mockResolvedValue({ ivaCondition: "Monotributista" });
    prismaMock.arcaCredential.findUnique.mockResolvedValue(null);

    // First call: agent supplies tipo="B" (wrong — Monotributista cannot emit B).
    idempotencyMock.begin.mockResolvedValueOnce({ kind: "execute", recordId: "m3-rec-1" });
    emitMock.mockResolvedValueOnce({ ...EMIT_RESULT_RAW, tipo: "C" as const, numero: 10 });

    // Second call: agent self-corrects to tipo="C" (already correct).
    // After canonicalization both map to "C" → same key → replay path.
    idempotencyMock.begin.mockResolvedValueOnce({
      kind: "replay",
      status: 200,
      body: { ...EXPECTED_RESULT, tipo: "C", numero: 10 },
    });

    const adapterLocal = new VeloraFiscalAdapter();

    const result1 = await adapterLocal.emitInvoice({
      ...EMIT_INPUT,
      tipo: "B", // agent-supplied (wrong — Monotributista correction will override to C)
    });

    const result2 = await adapterLocal.emitInvoice({
      ...EMIT_INPUT,
      tipo: "C", // agent self-corrected (already canonical)
    });

    // The two begin() calls must have used the SAME idempotency key (canonical tipo="C" for both).
    const key1 = idempotencyMock.begin.mock.calls[0]?.[0]?.idempotencyKey as string;
    const key2 = idempotencyMock.begin.mock.calls[1]?.[0]?.idempotencyKey as string;
    expect(key1).toBeDefined();
    expect(key2).toBeDefined();
    expect(key1).toEqual(key2); // same canonical tipo → same key

    // emit() called exactly ONCE: the retry hit the replay path.
    expect(emitMock).toHaveBeenCalledOnce();

    // Both results reflect tipo="C".
    expect((result1 as { tipo: string }).tipo).toBe("C");
    expect((result2 as { tipo: string; replayed?: boolean }).replayed).toBe(true);
  });

  it("M-3 anti-dedup guard: same canonical tipo but DIFFERENT customerCuit → DIFFERENT keys (no false dedup)", async () => {
    prismaMock.business.findUnique.mockResolvedValue({ ivaCondition: "Monotributista" });
    prismaMock.arcaCredential.findUnique.mockResolvedValue(null);

    // Two different customers, both with tipo="B" (both will canonicalize to "C").
    idempotencyMock.begin
      .mockResolvedValueOnce({ kind: "execute", recordId: "m3-anti-1" })
      .mockResolvedValueOnce({ kind: "execute", recordId: "m3-anti-2" });
    emitMock.mockResolvedValue({ ...EMIT_RESULT_RAW, tipo: "C" as const });

    const adapterLocal = new VeloraFiscalAdapter();

    await adapterLocal.emitInvoice({ ...EMIT_INPUT, tipo: "B", customerCuit: "20055361682" });
    await adapterLocal.emitInvoice({ ...EMIT_INPUT, tipo: "B", customerCuit: "27312456789" });

    const key1 = idempotencyMock.begin.mock.calls[0]?.[0]?.idempotencyKey as string;
    const key2 = idempotencyMock.begin.mock.calls[1]?.[0]?.idempotencyKey as string;
    // Different customerCuit → different keys, even though canonical tipo is the same.
    expect(key1).not.toEqual(key2);
    // Both invocations reached emit() (no false replay).
    expect(emitMock).toHaveBeenCalledTimes(2);
  });

  // ── 7. H-2: replay adds replayed:true marker ───────────────────────────────

  it("H-2: replay result includes replayed:true so the caller knows it is from the original emission", async () => {
    idempotencyMock.begin.mockResolvedValue({
      kind: "replay",
      status: 200,
      body: EXPECTED_RESULT,
    });

    const result = await adapter.emitInvoice(EMIT_INPUT) as typeof EXPECTED_RESULT & { replayed?: boolean };

    expect(result.replayed).toBe(true);
    // Core fiscal data is preserved from the original emission.
    expect(result).toMatchObject(EXPECTED_RESULT);
  });

  // ── 8. H-1: transport error → no release; AFIP-level error → release ───────

  it("H-1: transport/timeout error → idempotency record NOT released, EMIT_TRANSPORT_ERROR thrown", async () => {
    idempotencyMock.begin.mockResolvedValue({ kind: "execute", recordId: RECORD_ID });
    const transportErr = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    emitMock.mockRejectedValue(transportErr);

    const thrown = await adapter.emitInvoice(EMIT_INPUT).catch((e: Error) => e);

    expect((thrown as Error).message).toMatch(/EMIT_TRANSPORT_ERROR/);
    // Critical assertion: release must NOT be called for transport errors.
    expect(idempotencyMock.release).not.toHaveBeenCalled();
    // A WARNING log must be emitted.
    expect(cloudLogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: "WARNING",
        action: "EMIT_TRANSPORT_ERROR_NO_RELEASE",
      }),
    );
  });

  it("H-1: AFIP-level rejection (non-transport) → idempotency record IS released", async () => {
    idempotencyMock.begin.mockResolvedValue({ kind: "execute", recordId: RECORD_ID });
    // Structured AFIP SOAP fault — not a transport error
    emitMock.mockRejectedValue(new Error("WSFE fault: ObservacionesArray[0].Code=10016"));

    await expect(adapter.emitInvoice(EMIT_INPUT)).rejects.toThrow("WSFE fault");

    // release MUST be called: AFIP rejected, no sequential number consumed.
    expect(idempotencyMock.release).toHaveBeenCalledWith(RECORD_ID);
  });

  it("H-1: AbortError is treated as transport → record NOT released", async () => {
    idempotencyMock.begin.mockResolvedValue({ kind: "execute", recordId: RECORD_ID });
    const abort = Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
    emitMock.mockRejectedValue(abort);

    await expect(adapter.emitInvoice(EMIT_INPUT)).rejects.toThrow(/EMIT_TRANSPORT_ERROR/);
    expect(idempotencyMock.release).not.toHaveBeenCalled();
  });

  // ── 9. H-3: conflict → single retry; missing → descriptive error ────────────

  it("H-3: conflict outcome → retries begin() once; on execute retry, calls emit()", async () => {
    // First begin() returns conflict (prune-race).
    idempotencyMock.begin
      .mockResolvedValueOnce({ kind: "conflict" })
      // Retry succeeds with execute.
      .mockResolvedValueOnce({ kind: "execute", recordId: "retry-record" });

    emitMock.mockResolvedValue(EMIT_RESULT_RAW);

    const result = await adapter.emitInvoice(EMIT_INPUT);

    expect(idempotencyMock.begin).toHaveBeenCalledTimes(2);
    expect(emitMock).toHaveBeenCalledOnce();
    expect(result).toMatchObject(EXPECTED_RESULT);
  });

  it("H-3: conflict twice → descriptive EMIT_IDEMPOTENCY_CONFLICT error", async () => {
    idempotencyMock.begin
      .mockResolvedValueOnce({ kind: "conflict" })
      .mockResolvedValueOnce({ kind: "conflict" });

    await expect(adapter.emitInvoice(EMIT_INPUT)).rejects.toThrow("EMIT_IDEMPOTENCY_CONFLICT");
    expect(emitMock).not.toHaveBeenCalled();
  });

  it("H-3: missing outcome → descriptive EMIT_IDEMPOTENCY_MISSING error", async () => {
    idempotencyMock.begin.mockResolvedValue({ kind: "missing" });

    await expect(adapter.emitInvoice(EMIT_INPUT)).rejects.toThrow("EMIT_IDEMPOTENCY_MISSING");
    expect(emitMock).not.toHaveBeenCalled();
  });
});

// ── emitNota — same control flow, verify key derivation uses cbteAsoc ─────────

describe("VeloraFiscalAdapter.emitNota — idempotency layer", () => {
  let adapter: VeloraFiscalAdapter;

  const NOTA_INPUT = {
    tenantId: TENANT_ID,
    customerCuit: "20055361682",
    amountARS: 500,
    tipo: "C" as const,
    kind: "credito" as const,
    cbteAsoc: { tipo: 11 as const, ptoVta: 1, nro: 42 },
    concept: "Nota de crédito",
  };

  const NOTA_RAW = {
    sandbox: true as const,
    cae: "98765432109876",
    vencimiento: "20260630",
    tipo: "C" as const,
    numero: 55,
    customerCuit: NOTA_INPUT.customerCuit,
    amountARS: NOTA_INPUT.amountARS,
    concept: NOTA_INPUT.concept,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new VeloraFiscalAdapter();
    prismaMock.business.findUnique.mockResolvedValue({ ivaCondition: "Monotributista" });
    prismaMock.arcaCredential.findUnique.mockResolvedValue(null);
    emitMock.mockResolvedValue(NOTA_RAW);
    idempotencyMock.complete.mockResolvedValue(undefined);
    idempotencyMock.release.mockResolvedValue(undefined);
  });

  it("first call: calls emit() once and completes the record", async () => {
    idempotencyMock.begin.mockResolvedValue({ kind: "execute", recordId: "nota-record-1" });

    const result = await adapter.emitNota(NOTA_INPUT);

    expect(emitMock).toHaveBeenCalledOnce();
    expect(emitMock).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: TENANT_ID,
        noteKind: "credito",
        cbteAsoc: NOTA_INPUT.cbteAsoc,
      }),
    );
    expect(idempotencyMock.complete).toHaveBeenCalledOnce();
    expect(idempotencyMock.release).not.toHaveBeenCalled();
    expect(result).toMatchObject({ cae: "98765432109876", numero: 55, sandbox: true });
  });

  it("replay: returns stored result WITHOUT calling emit()", async () => {
    const stored = { sandbox: true, cae: "98765432109876", numero: 55 };
    idempotencyMock.begin.mockResolvedValue({ kind: "replay", status: 200, body: stored });

    const result = await adapter.emitNota(NOTA_INPUT);

    expect(emitMock).not.toHaveBeenCalled();
    expect(result).toMatchObject(stored);
  });

  it("replay: returns replayed:true marker on emitNota", async () => {
    const stored = { sandbox: true, cae: "98765432109876", numero: 55 };
    idempotencyMock.begin.mockResolvedValue({ kind: "replay", status: 200, body: stored });

    const result = await adapter.emitNota(NOTA_INPUT) as typeof stored & { replayed?: boolean };

    expect(result.replayed).toBe(true);
  });

  it("actionType used for emit_nota is 'fiscal.emit_nota'", async () => {
    idempotencyMock.begin.mockResolvedValue({ kind: "execute", recordId: "nota-record-2" });

    await adapter.emitNota(NOTA_INPUT);

    expect(idempotencyMock.begin).toHaveBeenCalledWith(
      expect.objectContaining({ actionType: "fiscal.emit_nota" }),
    );
  });

  it("C-1: emitNota with different puntoVenta produces a different key", async () => {
    // PtoVta 1
    prismaMock.arcaCredential.findUnique.mockResolvedValueOnce({ puntoVenta: 1 });
    idempotencyMock.begin.mockResolvedValueOnce({ kind: "execute", recordId: "nota-rec-1" });
    emitMock.mockResolvedValueOnce(NOTA_RAW);

    // PtoVta 3
    prismaMock.arcaCredential.findUnique.mockResolvedValueOnce({ puntoVenta: 3 });
    idempotencyMock.begin.mockResolvedValueOnce({ kind: "execute", recordId: "nota-rec-3" });
    emitMock.mockResolvedValueOnce({ ...NOTA_RAW, numero: 66 });

    const adapterLocal = new VeloraFiscalAdapter();
    await adapterLocal.emitNota(NOTA_INPUT);
    await adapterLocal.emitNota(NOTA_INPUT);

    const key1 = idempotencyMock.begin.mock.calls[0]?.[0]?.idempotencyKey as string;
    const key2 = idempotencyMock.begin.mock.calls[1]?.[0]?.idempotencyKey as string;
    expect(key1).not.toEqual(key2);
    expect(emitMock).toHaveBeenCalledTimes(2);
  });
});
