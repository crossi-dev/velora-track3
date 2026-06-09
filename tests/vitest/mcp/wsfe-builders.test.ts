// tests/vitest/mcp/wsfe-builders.test.ts
//
// Unit tests for buildFECAESolicitarBody — Phase 3 additions:
//   1. CbtesAsoc XML block is present when cbteAsoc is provided.
//   2. Guard throws when NC/ND tipo is used without cbteAsoc.
//   3. Guard does NOT throw for plain invoice tipos (1/6/11).
//
// buildFECAESolicitarBody is a pure function (string → string with no I/O),
// so no mocks are needed.

import { describe, it, expect } from "vitest";
import { buildFECAESolicitarBody } from "@/app/api/agents/fiscal/jsonrpc/_lib/arca-real/wsfe-builders";
import type { EmitInvoiceInput } from "@/app/api/agents/fiscal/jsonrpc/_lib/arca-real/types";
import type { ArcaTicket } from "@/app/api/agents/fiscal/jsonrpc/_lib/arca-real/types";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const TICKET: ArcaTicket = {
  token: "tok",
  sign: "sig",
  expiresAt: "2099-01-01T00:00:00Z",
};

const WSFE_NS = "https://wsfe.afip.gov.ar/";
const CBTE_DATE = "20260601";
const CBTE_NRO = 1;

function baseInput(overrides: Partial<EmitInvoiceInput> = {}): EmitInvoiceInput {
  return {
    cuit: "30055361685",
    puntoVenta: 1,
    tipoComprobante: 11, // Factura C by default
    customerCuit: "20055361682",
    importeTotal: 1000,
    importeNoGravado: 0,
    importeNeto: 1000,
    importeExento: 0,
    ivaItems: [],
    concepto: 1,
    ...overrides,
  };
}

// ── Guard: NC/ND without cbteAsoc must throw ──────────────────────────────────

describe("buildFECAESolicitarBody — NC/ND guard", () => {
  const NC_ND_TIPOS = [2, 3, 7, 8, 12, 13] as const;

  for (const tipo of NC_ND_TIPOS) {
    it(`throws for tipoComprobante=${tipo} without cbteAsoc`, () => {
      const input = baseInput({
        tipoComprobante: tipo,
        // NC/ND A requires customerCuit — supply one so we only hit the NC/ND guard
        customerCuit: "20055361682",
      });
      expect(() =>
        buildFECAESolicitarBody(input, TICKET, CBTE_NRO, CBTE_DATE, WSFE_NS),
      ).toThrow(/comprobante asociado/i);
    });
  }
});

// ── Guard: plain invoice tipos must NOT throw ─────────────────────────────────

describe("buildFECAESolicitarBody — plain invoice tipos pass guard", () => {
  it("does not throw for tipoComprobante=11 (Factura C) without cbteAsoc", () => {
    const input = baseInput({ tipoComprobante: 11 });
    expect(() =>
      buildFECAESolicitarBody(input, TICKET, CBTE_NRO, CBTE_DATE, WSFE_NS),
    ).not.toThrow();
  });

  it("does not throw for tipoComprobante=6 (Factura B) without cbteAsoc", () => {
    const input = baseInput({ tipoComprobante: 6 });
    expect(() =>
      buildFECAESolicitarBody(input, TICKET, CBTE_NRO, CBTE_DATE, WSFE_NS),
    ).not.toThrow();
  });

  it("does not throw for tipoComprobante=1 (Factura A) with customerCuit", () => {
    const input = baseInput({ tipoComprobante: 1, customerCuit: "20055361682" });
    expect(() =>
      buildFECAESolicitarBody(input, TICKET, CBTE_NRO, CBTE_DATE, WSFE_NS),
    ).not.toThrow();
  });
});

// ── CbtesAsoc XML block ───────────────────────────────────────────────────────

describe("buildFECAESolicitarBody — CbtesAsoc XML block", () => {
  it("emits CbtesAsoc block when cbteAsoc is provided (NC C example)", () => {
    const input = baseInput({
      tipoComprobante: 13, // Nota Crédito C
      cbteAsoc: { tipo: 11, ptoVta: 1, nro: 42 },
    });
    const xml = buildFECAESolicitarBody(input, TICKET, CBTE_NRO, CBTE_DATE, WSFE_NS);
    expect(xml).toContain("<ar:CbtesAsoc>");
    expect(xml).toContain("<ar:Tipo>11</ar:Tipo>");
    expect(xml).toContain("<ar:PtoVta>1</ar:PtoVta>");
    expect(xml).toContain("<ar:Nro>42</ar:Nro>");
    expect(xml).toContain("</ar:CbtesAsoc>");
  });

  it("emits CbtesAsoc block with correct values for ND A (tipo=2)", () => {
    const input = baseInput({
      tipoComprobante: 2, // Nota Débito A
      customerCuit: "20055361682",
      cbteAsoc: { tipo: 1, ptoVta: 3, nro: 100 },
    });
    const xml = buildFECAESolicitarBody(input, TICKET, CBTE_NRO, CBTE_DATE, WSFE_NS);
    expect(xml).toContain("<ar:Tipo>1</ar:Tipo>");
    expect(xml).toContain("<ar:PtoVta>3</ar:PtoVta>");
    expect(xml).toContain("<ar:Nro>100</ar:Nro>");
  });

  it("omits CbtesAsoc block entirely for plain invoice (Factura C)", () => {
    const input = baseInput({ tipoComprobante: 11 });
    const xml = buildFECAESolicitarBody(input, TICKET, CBTE_NRO, CBTE_DATE, WSFE_NS);
    expect(xml).not.toContain("CbtesAsoc");
  });
});
