const assert = require("node:assert/strict");
const test = require("node:test");

const {
  discoverAgent,
  sendMessage,
  callAgent,
  A2AClientError,
} = require("../../src/lib/a2a-client.ts");

// Minimal A2A v0.3.0 agent card fixture
const FIXTURE_CARD = {
  protocolVersion: "0.3.0",
  name: "Test Agent",
  description: "A test agent",
  url: "https://test.example/api/a2a/jsonrpc",
  version: "0.1.0",
  capabilities: { streaming: false, pushNotifications: false },
  defaultInputModes: ["text"],
  defaultOutputModes: ["text"],
  skills: [{ id: "s1", name: "Skill 1", description: "test skill" }],
};

function mockFetchOnce(response, status = 200) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => response,
  });
  return () => {
    globalThis.fetch = original;
  };
}

function mockFetchSequence(responses) {
  const original = globalThis.fetch;
  let i = 0;
  globalThis.fetch = async () => {
    const entry = responses[i++];
    if (!entry) throw new Error("mock fetch exhausted");
    return {
      ok: entry.status >= 200 && entry.status < 300,
      status: entry.status ?? 200,
      json: async () => entry.body,
    };
  };
  return () => {
    globalThis.fetch = original;
  };
}

// ── discoverAgent ─────────────────────────────────────────────────────

test("discoverAgent: fetches /.well-known/agent-card.json + returns parsed card", async () => {
  const restore = mockFetchOnce(FIXTURE_CARD);
  try {
    const card = await discoverAgent("https://test.example");
    assert.equal(card.name, "Test Agent");
    assert.equal(card.protocolVersion, "0.3.0");
    assert.equal(card.skills.length, 1);
  } finally {
    restore();
  }
});

test("discoverAgent: strips trailing slash from base URL", async () => {
  let calledUrl = "";
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calledUrl = url;
    return { ok: true, status: 200, json: async () => FIXTURE_CARD };
  };
  try {
    await discoverAgent("https://test.example/");
    assert.equal(calledUrl, "https://test.example/.well-known/agent-card.json");
  } finally {
    globalThis.fetch = original;
  }
});

test("discoverAgent: throws A2AClientError on HTTP error", async () => {
  const restore = mockFetchOnce({}, 404);
  try {
    await assert.rejects(
      () => discoverAgent("https://test.example"),
      (err) => err instanceof A2AClientError && err.code === 404
    );
  } finally {
    restore();
  }
});

test("discoverAgent: throws on missing required fields", async () => {
  const restore = mockFetchOnce({ name: "Bad" });
  try {
    await assert.rejects(
      () => discoverAgent("https://test.example"),
      (err) => err instanceof A2AClientError && /required fields/i.test(err.message)
    );
  } finally {
    restore();
  }
});

// ── sendMessage ───────────────────────────────────────────────────────

test("sendMessage: sends correct JSON-RPC body + parses Message reply", async () => {
  let capturedBody;
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    capturedBody = JSON.parse(init.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        jsonrpc: "2.0",
        id: capturedBody.id,
        result: {
          kind: "message",
          messageId: "reply-id",
          role: "agent",
          parts: [{ kind: "text", text: "hello back" }],
          contextId: "ctx-1",
        },
      }),
    };
  };
  try {
    const reply = await sendMessage("https://test.example/api/a2a/jsonrpc", "hi");
    assert.equal(capturedBody.jsonrpc, "2.0");
    assert.equal(capturedBody.method, "message/send");
    assert.equal(capturedBody.params.message.parts[0].text, "hi");
    assert.equal(reply.text, "hello back");
    assert.equal(reply.contextId, "ctx-1");
  } finally {
    globalThis.fetch = original;
  }
});

test("sendMessage: includes X-API-Key header when apiKey provided", async () => {
  let capturedHeaders;
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    capturedHeaders = init.headers;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        jsonrpc: "2.0",
        id: "x",
        result: { kind: "message", messageId: "r", role: "agent", parts: [{ kind: "text", text: "ok" }] },
      }),
    };
  };
  try {
    await sendMessage("https://test.example/api/a2a/jsonrpc", "hi", { apiKey: "secret-key" });
    assert.equal(capturedHeaders["X-API-Key"], "secret-key");
  } finally {
    globalThis.fetch = original;
  }
});

test("sendMessage: throws A2AClientError when JSON-RPC error returned", async () => {
  const restore = mockFetchOnce({
    jsonrpc: "2.0",
    id: "x",
    error: { code: -32601, message: "Method not found" },
  });
  try {
    await assert.rejects(
      () => sendMessage("https://test.example/api/a2a/jsonrpc", "hi"),
      (err) => err instanceof A2AClientError && err.code === -32601
    );
  } finally {
    restore();
  }
});

test("sendMessage: throws when result has unsupported kind", async () => {
  const restore = mockFetchOnce({
    jsonrpc: "2.0",
    id: "x",
    result: { kind: "task", id: "t", status: { state: "submitted" } },
  });
  try {
    await assert.rejects(
      () => sendMessage("https://test.example/api/a2a/jsonrpc", "hi"),
      (err) => err instanceof A2AClientError && /unsupported result kind: task/i.test(err.message)
    );
  } finally {
    restore();
  }
});

test("sendMessage: concatenates multiple text parts in reply", async () => {
  const restore = mockFetchOnce({
    jsonrpc: "2.0",
    id: "x",
    result: {
      kind: "message",
      messageId: "r",
      role: "agent",
      parts: [
        { kind: "text", text: "line 1" },
        { kind: "text", text: "line 2" },
      ],
    },
  });
  try {
    const reply = await sendMessage("https://test.example/api/a2a/jsonrpc", "hi");
    assert.equal(reply.text, "line 1\nline 2");
  } finally {
    restore();
  }
});

test("sendMessage: forwards contextId in request when provided", async () => {
  let capturedBody;
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    capturedBody = JSON.parse(init.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        jsonrpc: "2.0",
        id: "x",
        result: { kind: "message", messageId: "r", role: "agent", parts: [{ kind: "text", text: "ok" }] },
      }),
    };
  };
  try {
    await sendMessage("https://test.example/api/a2a/jsonrpc", "hi", { contextId: "existing-ctx" });
    assert.equal(capturedBody.params.message.contextId, "existing-ctx");
  } finally {
    globalThis.fetch = original;
  }
});

// ── callAgent (discover + send) ──────────────────────────────────────

test("callAgent: discovers + sends in one call, uses card.url as endpoint", async () => {
  const callUrls = [];
  const original = globalThis.fetch;
  let i = 0;
  const responses = [
    { status: 200, body: FIXTURE_CARD },
    {
      status: 200,
      body: {
        jsonrpc: "2.0",
        id: "x",
        result: { kind: "message", messageId: "r", role: "agent", parts: [{ kind: "text", text: "yes" }] },
      },
    },
  ];
  globalThis.fetch = async (url) => {
    callUrls.push(url);
    const entry = responses[i++];
    return { ok: true, status: entry.status, json: async () => entry.body };
  };
  try {
    const reply = await callAgent("https://test.example", "hello");
    assert.equal(reply.agentName, "Test Agent");
    assert.equal(reply.text, "yes");
    assert.equal(callUrls[0], "https://test.example/.well-known/agent-card.json");
    assert.equal(callUrls[1], FIXTURE_CARD.url);
  } finally {
    globalThis.fetch = original;
  }
});
