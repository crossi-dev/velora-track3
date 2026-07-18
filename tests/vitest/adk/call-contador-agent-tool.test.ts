// tests/vitest/adk/call-contador-agent-tool.test.ts
//
// Pins a word-boundary regex bug in buildContadorFullMessage (F-6 customer
// fiscal enrichment): the boundary character class was written as a template
// literal `\w`, which JS drops to a literal "w" outside of a real regex
// literal. The RegExp constructor then only excludes the letter "w" (plus
// the explicit accented-letter range) from the boundary, instead of any
// word character -- so a customer name embedded inside a longer word (e.g.
// "marta" inside "xmartay") is wrongly treated as a whole-word match and the
// customer's fiscal data leaks into the brief sent to the Contador agent.
//
// Mocked: @/lib/prisma (customer.findMany only -- buildContadorFullMessage
// does not call the CUIT precondition guard, so no other Prisma model/table
// is touched).

import { describe, it, expect, vi } from "vitest";
import { buildContadorFullMessage } from "@/lib/adk/tools/call-contador-agent-tool";
import type { CallContadorAgentToolContext } from "@/lib/adk/tools/call-contador-agent-tool";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const { customerFindManyMock } = vi.hoisted(() => ({
  customerFindManyMock: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    customer: { findMany: customerFindManyMock },
  },
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

const BUSINESS_ID = "biz-test-contador-001";

function makeCtx(): CallContadorAgentToolContext {
  return {
    businessId: BUSINESS_ID,
    appUrl: "https://example.test",
    apiKey: undefined,
  };
}

// ── buildContadorFullMessage -- word-boundary customer name matching ──────────

describe("buildContadorFullMessage -- customer name word-boundary matching", () => {
  it("does NOT attach fiscal data when the customer name is only a substring of a longer word", async () => {
    customerFindManyMock.mockResolvedValue([
      { name: "Marta", taxId: "20111111112", ivaCondition: "Responsable Inscripto" },
    ]);

    // "marta" appears inside "xmartay" -- not as a standalone word/token.
    const result = await buildContadorFullMessage(
      { message: "hablo con xmartay sobre la factura" },
      makeCtx(),
    );

    expect(result).not.toContain("DATOS FISCALES DEL CLIENTE");
  });

  it("DOES attach fiscal data when the customer name appears as a whole word", async () => {
    customerFindManyMock.mockResolvedValue([
      { name: "Marta", taxId: "20111111112", ivaCondition: "Responsable Inscripto" },
    ]);

    const result = await buildContadorFullMessage(
      { message: "hablo con marta sobre la factura" },
      makeCtx(),
    );

    expect(result).toContain("DATOS FISCALES DEL CLIENTE");
    expect(result).toContain("CUIT del cliente: 20111111112");
  });
});
