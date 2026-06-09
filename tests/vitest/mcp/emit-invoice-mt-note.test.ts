// tests/vitest/mcp/emit-invoice-mt-note.test.ts
//
// Regression test for the MT note IVA bug (JD finding):
//   Before the fix, isMonotributo only checked tipoComprobante === 11 (Factura C).
//   NC C (13) and ND C (12) fell through to splitIva21 → wrong 21% IVA split →
//   AFIP error 10016.
//
// This test exercises the REAL emit() wsfeInput construction path
// (ARCA_REAL_MODE=true) by mocking only the I/O seams (prisma, wsaa, wsfe,
// demo-testers) so no network calls are made.
//
// Mock seams:
//   @/lib/prisma              → arcaCredential.findUnique returns a fake MT credential
//   @/lib/demo-testers        → isBusinessDemoTester returns false (not a demo account)
//   ./wsaa (relative to emit-invoice.ts) → getTicket returns a fake ticket
//   ./wsfe (relative to emit-invoice.ts) → wsfeEmitInvoice captures the input arg
//
// vi.mock paths must be module-ID strings exactly as they appear in the
// importing file's import statements (emit-invoice.ts line ~19-20).

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mock factories (run before module graph resolution) ───────────────

const { capturedWsfeInput, wsfeEmitMock, getTicketMock, prismaMock, isDemoTesterMock } =
  vi.hoisted(() => {
    let capturedInput: unknown = null;
    const wsfeEmit = vi.fn().mockImplementation((input: unknown) => {
      capturedInput = input;
      return Promise.resolve({
        sandbox: false,
        cae: "66000000000001",
        vencimientoCae: "20260611",
        numero: 1,
        tipoComprobante: 13,
        puntoVenta: 1,
        issuedAt: "2026-06-01T00:00:00.000Z",
      });
    });
    return {
      capturedWsfeInput: { get: () => capturedInput, reset: () => { capturedInput = null; } },
      wsfeEmitMock: wsfeEmit,
      getTicketMock: vi.fn().mockResolvedValue({ token: "tok", sign: "sig", expiresAt: "2099-01-01T00:00:00Z" }),
      prismaMock: {
        arcaCredential: {
          findUnique: vi.fn(),
        },
      },
      isDemoTesterMock: vi.fn().mockResolvedValue(false),
    };
  });

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));

vi.mock("@/lib/demo-testers", () => ({
  isBusinessDemoTester: isDemoTesterMock,
}));

// emit-invoice.ts imports wsaa and wsfe with relative paths: "./wsaa" and "./wsfe"
// Vitest resolves vi.mock paths relative to the test file when using the module-id
// string. For cross-directory mocks we must use the resolved module path alias.
vi.mock(
  "@/app/api/agents/fiscal/jsonrpc/_lib/arca-real/wsaa",
  () => ({
    getTicket: getTicketMock,
    evictTicket: vi.fn(),
  }),
);

vi.mock(
  "@/app/api/agents/fiscal/jsonrpc/_lib/arca-real/wsfe",
  () => ({
    emitInvoice: wsfeEmitMock,
  }),
);

// ── Fake MT credential ────────────────────────────────────────────────────────

const MT_CREDENTIAL = {
  businessId: "biz-mt-test",
  cuit: "30055361685",
  puntoVenta: 1,
  condicionIva: "MT",
  certGcsPath: "velora-arca-certs/biz-mt-test.p12",
  // Credential loader takes passphraseSecretName or encryptedPassphrase.
  // We must bypass the passphrase resolution path too.
  passphraseSecretName: null,
  encryptedPassphrase: "ignored-in-mock",
  environment: "homo",
};

// ── RI credential (Responsable Inscripto — for contrasting case) ──────────────

const RI_CREDENTIAL = {
  ...MT_CREDENTIAL,
  condicionIva: "RI",
};

// ── Subject under test ────────────────────────────────────────────────────────

// Import AFTER mocks are declared.
// eslint-disable-next-line import/order
import { emit } from "@/app/api/agents/fiscal/jsonrpc/_lib/arca-real/emit-invoice";

// ── Helpers ───────────────────────────────────────────────────────────────────

// decrypt is called by loadCredential when encryptedPassphrase is present.
// We need to mock it so the credential loader can build the passphrase.
// Import it so we can spy on it — but since the module is mocked at a higher
// level (prisma mock returns credential data), the credential loader's decrypt
// call path is what matters.
//
// Actually, loadCredential calls decrypt from @velora/core-utils/mp-token-cipher
// (moved from @/infrastructure/crypto/mp-token-cipher in Phase 2 S1).
// only when passphraseSecretName is null AND encryptedPassphrase is not null.
// We mock that module too.
vi.mock("@velora/core-utils/mp-token-cipher", () => ({
  decrypt: vi.fn().mockReturnValue("fake-passphrase"),
}));

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("emit() — MT note IVA regression (JD finding: AFIP error 10016)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedWsfeInput.reset();
    isDemoTesterMock.mockResolvedValue(false);
    getTicketMock.mockResolvedValue({ token: "tok", sign: "sig", expiresAt: "2099-01-01T00:00:00Z" });
    wsfeEmitMock.mockImplementation((input: unknown) => {
      // Re-capture on each test (cleared above)
      (capturedWsfeInput as { get: () => unknown; reset: () => void } & { _val?: unknown })._val = input;
      return Promise.resolve({
        sandbox: false,
        cae: "66000000000001",
        vencimientoCae: "20260611",
        numero: 1,
        tipoComprobante: 13,
        puntoVenta: 1,
        issuedAt: "2026-06-01T00:00:00.000Z",
      });
    });
  });

  // ── MT credit note (NC C = tipo 13) — the bug case ───────────────────────

  it("MT credit note (NC C) carries NO IVA — ivaItems=[] and importeNeto===amountARS", async () => {
    process.env.ARCA_REAL_MODE = "true";
    prismaMock.arcaCredential.findUnique.mockResolvedValue(MT_CREDENTIAL);

    let capturedInput: unknown = null;
    wsfeEmitMock.mockImplementation((input: unknown) => {
      capturedInput = input;
      return Promise.resolve({
        sandbox: false,
        cae: "66000000000013",
        vencimientoCae: "20260611",
        numero: 1,
        tipoComprobante: 13,
        puntoVenta: 1,
        issuedAt: "2026-06-01T00:00:00.000Z",
      });
    });

    await emit({
      businessId: "biz-mt-test",
      customerCuit: "20055361682",
      amountARS: 1000,
      tipo: "C",
      noteKind: "credito",
      cbteAsoc: { tipo: 11, ptoVta: 1, nro: 1 },
      condicionIva: "MT",
    });

    expect(wsfeEmitMock).toHaveBeenCalledOnce();
    const input = capturedInput as {
      ivaItems: unknown[];
      importeNeto: number;
      importeTotal: number;
    };
    // No IVA items on MT note
    expect(input.ivaItems).toEqual([]);
    // importeNeto must equal the full amount (no split)
    expect(input.importeNeto).toBe(1000);
    expect(input.importeTotal).toBe(1000);
    // The neto equals the total — zero IVA split
    expect(input.importeNeto).toBe(input.importeTotal);

    delete process.env.ARCA_REAL_MODE;
  });

  // ── MT debit note (ND C = tipo 12) — same family ─────────────────────────

  it("MT debit note (ND C) carries NO IVA — ivaItems=[] and importeNeto===amountARS", async () => {
    process.env.ARCA_REAL_MODE = "true";
    prismaMock.arcaCredential.findUnique.mockResolvedValue(MT_CREDENTIAL);

    let capturedInput: unknown = null;
    wsfeEmitMock.mockImplementation((input: unknown) => {
      capturedInput = input;
      return Promise.resolve({
        sandbox: false,
        cae: "66000000000012",
        vencimientoCae: "20260611",
        numero: 2,
        tipoComprobante: 12,
        puntoVenta: 1,
        issuedAt: "2026-06-01T00:00:00.000Z",
      });
    });

    await emit({
      businessId: "biz-mt-test",
      customerCuit: "20055361682",
      amountARS: 500,
      tipo: "C",
      noteKind: "debito",
      cbteAsoc: { tipo: 11, ptoVta: 1, nro: 2 },
      condicionIva: "MT",
    });

    const input = capturedInput as {
      ivaItems: unknown[];
      importeNeto: number;
      importeTotal: number;
    };
    expect(input.ivaItems).toEqual([]);
    expect(input.importeNeto).toBe(500);
    expect(input.importeNeto).toBe(input.importeTotal);

    delete process.env.ARCA_REAL_MODE;
  });

  // ── Contrasting case: RI credit note DOES get the 21% IVA split ──────────

  it("RI credit note (NC A) carries 21% IVA — ivaItems has entry and importeNeto < importeTotal", async () => {
    process.env.ARCA_REAL_MODE = "true";
    prismaMock.arcaCredential.findUnique.mockResolvedValue(RI_CREDENTIAL);

    let capturedInput: unknown = null;
    wsfeEmitMock.mockImplementation((input: unknown) => {
      capturedInput = input;
      return Promise.resolve({
        sandbox: false,
        cae: "66000000000003",
        vencimientoCae: "20260611",
        numero: 3,
        tipoComprobante: 3,
        puntoVenta: 1,
        issuedAt: "2026-06-01T00:00:00.000Z",
      });
    });

    await emit({
      businessId: "biz-mt-test",
      customerCuit: "20055361682",
      amountARS: 1210,
      tipo: "A",
      noteKind: "credito",
      cbteAsoc: { tipo: 1, ptoVta: 1, nro: 1 },
      condicionIva: "RI",
    });

    const input = capturedInput as {
      ivaItems: Array<{ id: number; baseImponible: number; importe: number }>;
      importeNeto: number;
      importeTotal: number;
    };
    // RI note must have a 21% IVA entry (alicuota id=5)
    expect(input.ivaItems).toHaveLength(1);
    expect(input.ivaItems[0].id).toBe(5); // 21%
    expect(input.ivaItems[0].importe).toBeGreaterThan(0);
    // neto must be LESS than total (IVA was split out)
    expect(input.importeNeto).toBeLessThan(input.importeTotal);
    // neto + iva must equal total exactly
    expect(input.importeNeto + input.ivaItems[0].importe).toBeCloseTo(input.importeTotal, 2);

    delete process.env.ARCA_REAL_MODE;
  });
});
