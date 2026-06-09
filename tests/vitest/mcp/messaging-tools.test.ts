// tests/vitest/mcp/messaging-tools.test.ts
//
// Unit tests for the WhatsApp messaging MCP tool registrations.
// Uses InMemoryTransport.createLinkedPair() from the MCP SDK — mirrors
// the ventas-tools.test.ts / payments-tools.test.ts style.
//
// Mocked dependencies:
//   - @/lib/whatsapp  — sendWhatsAppMessage + sendWhatsAppTemplate
//
// No real Meta API calls are made. Tests cover:
//   - tools/list includes send_whatsapp_text + send_whatsapp_template when businessId present
//   - tools NOT registered when no businessId
//   - send_whatsapp_text happy path (mock resolves → sent: true)
//   - send_whatsapp_text Meta error (e.g. 131026) → isError: true with message
//   - send_whatsapp_template happy path → sent: true
//   - send_whatsapp_template failure (template-not-active) → isError: true with message
//   - businessId comes from closure — sendWhatsAppMessage called with correct businessId
//   - send_whatsapp_template passes components correctly
//
// Pre-existing vitest failures on main (sale-post-commit-chain, employee-auth-edge)
// are unrelated — verify this file's pass count independently.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildVeloraMcpServer } from "@/lib/mcp/server";

// ── Mocks ─────────────────────────────────────────────────────────────────────
//
// vi.hoisted() runs before module graph resolution so mock factories can
// reference the fns before the vi.mock() calls.

const { sendWhatsAppMessageMock, sendWhatsAppTemplateMock } = vi.hoisted(() => ({
  sendWhatsAppMessageMock: vi.fn(),
  sendWhatsAppTemplateMock: vi.fn(),
}));

vi.mock("@/lib/whatsapp", () => ({
  sendWhatsAppMessage: sendWhatsAppMessageMock,
  sendWhatsAppTemplate: sendWhatsAppTemplateMock,
}));

// Stub prisma for fiscal/payments tools registered alongside messaging tools.
vi.mock("@/lib/prisma", () => ({
  prisma: {
    business: { findUnique: vi.fn().mockResolvedValue({ ivaCondition: "Monotributista" }) },
    arcaCredential: { findUnique: vi.fn().mockResolvedValue(null) },
    product: { findMany: vi.fn().mockResolvedValue([]) },
    // Stub for resolveTenantBackendMap — null = all env / "velora" defaults
    tenantToolConfig: { findUnique: vi.fn().mockResolvedValue(null) },
  },
}));

// ── Types ─────────────────────────────────────────────────────────────────────

interface TextContent {
  type: "text";
  text: string;
}

interface CallToolResult {
  isError?: boolean;
  content: TextContent[];
}

function asToolResult(raw: unknown): CallToolResult {
  return raw as CallToolResult;
}

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

// ── Registration ──────────────────────────────────────────────────────────────

describe("messaging tools — registration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendWhatsAppMessageMock.mockResolvedValue(undefined);
    sendWhatsAppTemplateMock.mockResolvedValue(undefined);
  });

  it("includes send_whatsapp_text and send_whatsapp_template when businessId is provided", async () => {
    const { client, cleanup } = await buildConnectedClient("biz-msg-001");
    try {
      const result = await client.listTools();
      const names = result.tools.map((t) => t.name);
      expect(names).toContain("send_whatsapp_text");
      expect(names).toContain("send_whatsapp_template");
    } finally {
      await cleanup();
    }
  });

  it("does NOT include messaging tools when no businessId is provided", async () => {
    const { client, cleanup } = await buildConnectedClient();
    try {
      const result = await client.listTools();
      const names = result.tools.map((t) => t.name);
      expect(names).not.toContain("send_whatsapp_text");
      expect(names).not.toContain("send_whatsapp_template");
    } finally {
      await cleanup();
    }
  });
});

// ── send_whatsapp_text ────────────────────────────────────────────────────────

describe("send_whatsapp_text tool", () => {
  const BUSINESS_ID = "biz-msg-text-001";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns sent: true on happy path", async () => {
    sendWhatsAppMessageMock.mockResolvedValue(undefined);

    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({
        name: "send_whatsapp_text",
        arguments: { to: "+5491151234567", text: "Hello from Velora" },
      });
      const result = asToolResult(raw);

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text) as { sent: boolean; to: string };
      expect(parsed.sent).toBe(true);
      expect(parsed.to).toBe("+5491151234567");
    } finally {
      await cleanup();
    }
  });

  it("returns isError: true with Meta error message on send failure (e.g. error 131026 out-of-window)", async () => {
    sendWhatsAppMessageMock.mockRejectedValue(
      new Error("Meta API error 131026: Message failed to send because more than 24 hours have passed"),
    );

    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({
        name: "send_whatsapp_text",
        arguments: { to: "+5491151234567", text: "Out-of-window message" },
      });
      const result = asToolResult(raw);

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text) as { code: string; message: string };
      expect(parsed.code).toBe("WHATSAPP_SEND_ERROR");
      expect(parsed.message).toContain("131026");
    } finally {
      await cleanup();
    }
  });

  it("passes businessId from closure as the fourth argument to sendWhatsAppMessage", async () => {
    sendWhatsAppMessageMock.mockResolvedValue(undefined);

    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      await client.callTool({
        name: "send_whatsapp_text",
        arguments: { to: "+5491151234567", text: "Closure test" },
      });
      expect(sendWhatsAppMessageMock).toHaveBeenCalledWith(
        "+5491151234567",
        "Closure test",
        undefined,
        BUSINESS_ID,
      );
    } finally {
      await cleanup();
    }
  });

  it("passes mediaUrl when provided", async () => {
    sendWhatsAppMessageMock.mockResolvedValue(undefined);
    const mediaUrl = "https://cdn.example.com/invoice.pdf";

    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      await client.callTool({
        name: "send_whatsapp_text",
        arguments: { to: "+5491151234567", text: "Your invoice", mediaUrl },
      });
      expect(sendWhatsAppMessageMock).toHaveBeenCalledWith(
        "+5491151234567",
        "Your invoice",
        mediaUrl,
        BUSINESS_ID,
      );
    } finally {
      await cleanup();
    }
  });
});

// ── send_whatsapp_template ────────────────────────────────────────────────────

describe("send_whatsapp_template tool", () => {
  const BUSINESS_ID = "biz-msg-tpl-001";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns sent: true on happy path", async () => {
    sendWhatsAppTemplateMock.mockResolvedValue(undefined);

    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({
        name: "send_whatsapp_template",
        arguments: {
          to: "+5491151234567",
          templateName: "velora_tracking_update",
          components: [
            { type: "body", parameters: [{ type: "text", text: "TRK-001" }] },
          ],
        },
      });
      const result = asToolResult(raw);

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text) as {
        sent: boolean;
        to: string;
        templateName: string;
      };
      expect(parsed.sent).toBe(true);
      expect(parsed.to).toBe("+5491151234567");
      expect(parsed.templateName).toBe("velora_tracking_update");
    } finally {
      await cleanup();
    }
  });

  it("returns isError: true when template is not active / send fails", async () => {
    sendWhatsAppTemplateMock.mockRejectedValue(
      new Error("Meta API error 132001: Template is not approved or does not exist"),
    );

    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      const raw = await client.callTool({
        name: "send_whatsapp_template",
        arguments: {
          to: "+5491151234567",
          templateName: "velora_pending_template",
        },
      });
      const result = asToolResult(raw);

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text) as { code: string; message: string };
      expect(parsed.code).toBe("WHATSAPP_TEMPLATE_ERROR");
      expect(parsed.message).toContain("132001");
    } finally {
      await cleanup();
    }
  });

  it("passes components and languageCode correctly to sendWhatsAppTemplate", async () => {
    sendWhatsAppTemplateMock.mockResolvedValue(undefined);
    const components = [{ type: "body" as const, parameters: [{ type: "text" as const, text: "Andrés" }] }];

    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      await client.callTool({
        name: "send_whatsapp_template",
        arguments: {
          to: "+5491151234567",
          templateName: "velora_tracking_update",
          components,
          languageCode: "es_AR",
        },
      });
      expect(sendWhatsAppTemplateMock).toHaveBeenCalledWith(
        "+5491151234567",
        "velora_tracking_update",
        components,
        "es_AR",
        BUSINESS_ID,
      );
    } finally {
      await cleanup();
    }
  });

  it("passes businessId from closure as the fifth argument to sendWhatsAppTemplate", async () => {
    sendWhatsAppTemplateMock.mockResolvedValue(undefined);

    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      await client.callTool({
        name: "send_whatsapp_template",
        arguments: {
          to: "+5491151234567",
          templateName: "velora_tracking_update",
        },
      });
      expect(sendWhatsAppTemplateMock).toHaveBeenCalledWith(
        "+5491151234567",
        "velora_tracking_update",
        [],
        undefined,
        BUSINESS_ID,
      );
    } finally {
      await cleanup();
    }
  });

  it("defaults components to empty array when omitted", async () => {
    sendWhatsAppTemplateMock.mockResolvedValue(undefined);

    const { client, cleanup } = await buildConnectedClient(BUSINESS_ID);
    try {
      await client.callTool({
        name: "send_whatsapp_template",
        arguments: { to: "+5491151234567", templateName: "velora_no_params" },
      });
      expect(sendWhatsAppTemplateMock).toHaveBeenCalledWith(
        "+5491151234567",
        "velora_no_params",
        [],
        undefined,
        BUSINESS_ID,
      );
    } finally {
      await cleanup();
    }
  });
});
