// tests/vitest/mcp/payments-tools.test.ts
//
// Unit tests for the payments MCP tool registrations.
// mp_create_preference and mp_payment_status were removed from the payments pack
// (commit 388070fe). get_payment_intent_status is the remaining payments tool.
//
// Uses InMemoryTransport.createLinkedPair() from the MCP SDK to wire a Client
// to the McpServer without any HTTP overhead — mirrors the fiscal-mcp-server.test.ts style.

import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildVeloraMcpServer } from "@/lib/mcp/server";

// fiscal-tools.ts and ventas-tools.ts use prisma — mock to avoid DB calls when businessId is present.
import { vi } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    business: { findUnique: vi.fn().mockResolvedValue({ ivaCondition: "Monotributista" }) },
    arcaCredential: { findUnique: vi.fn().mockResolvedValue(null) },
    product: { findMany: vi.fn().mockResolvedValue([]) },
    // Stub for resolveTenantBackendMap — null = all env / "velora" defaults
    tenantToolConfig: { findUnique: vi.fn().mockResolvedValue(null) },
  },
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

async function buildConnectedClient(businessId?: string): Promise<{
  client: Client;
  cleanup: () => Promise<void>;
}> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = await buildVeloraMcpServer(businessId);
  await server.connect(serverTransport);

  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(clientTransport);

  return {
    client,
    cleanup: async () => {
      await client.close();
      await server.close();
    },
  };
}

// ── tools/list — payments pack registration ───────────────────────────────────

describe("payments tools — registration", () => {
  it("includes get_payment_intent_status when businessId is provided", async () => {
    const { client, cleanup } = await buildConnectedClient("biz-mp-001");
    try {
      const result = await client.listTools();
      const names = result.tools.map((t) => t.name);
      expect(names).toContain("get_payment_intent_status");
    } finally {
      await cleanup();
    }
  });

  it("includes the payment-link wizard tools when businessId is provided", async () => {
    const { client, cleanup } = await buildConnectedClient("biz-mp-001");
    try {
      const result = await client.listTools();
      const names = result.tools.map((t) => t.name);
      expect(names).toContain("open_payment_link_wizard");
      expect(names).toContain("create_tracked_payment_link");
    } finally {
      await cleanup();
    }
  });

  it("does NOT include removed MP tools when businessId is provided", async () => {
    const { client, cleanup } = await buildConnectedClient("biz-mp-001");
    try {
      const result = await client.listTools();
      const names = result.tools.map((t) => t.name);
      expect(names).not.toContain("mp_create_preference");
      expect(names).not.toContain("mp_payment_status");
    } finally {
      await cleanup();
    }
  });

  it("does NOT include get_payment_intent_status when no businessId is provided", async () => {
    const { client, cleanup } = await buildConnectedClient(); // no businessId
    try {
      const result = await client.listTools();
      const names = result.tools.map((t) => t.name);
      expect(names).not.toContain("get_payment_intent_status");
    } finally {
      await cleanup();
    }
  });
});
