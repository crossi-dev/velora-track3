// Tests for src/lib/adk/agent-engine-session-service.ts
//
// Covers: feature flag gate, createSession, getSession, listSessions,
// deleteSession, appendEvent (fire-and-forget), graceful null on 5xx/timeout.

process.env.AUTH_SECRET = process.env.AUTH_SECRET || "test-ae-session-svc-secret-32xx";
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://test:test@localhost:5432/test";

const assert = require("node:assert/strict");
const test = require("node:test");
const Module = require("node:module");
const path = require("node:path");

const SUT_PATH = path.resolve(
  __dirname,
  "../../src/lib/adk/agent-engine-session-service.ts",
);

// ── Module stubs ──────────────────────────────────────────────────────────────

const origLoad = Module._load;
Module._load = function (request, parent, ...rest) {
  if (request === "google-auth-library") {
    return {
      GoogleAuth: class {
        async getClient() {
          return {
            async getAccessToken() {
              return { token: "fake-token" };
            },
          };
        }
      },
      // OAuth2Client isn't used by this SUT, but this stub replaces
      // Module._load globally for the rest of the in-process test run
      // (restored only on `process.exit`, which doesn't fire between
      // files under tests/unit/run-all.cjs). Omitting it here breaks
      // `new OAuth2Client()` in cron-auth.ts / oidc-verifiers.ts for any
      // test file that loads after this one.
      OAuth2Client: class {
        constructor() {}
        async verifyIdToken() {
          throw Object.assign(new Error("Token is invalid (test stub default)"), { code: 401 });
        }
      },
    };
  }
  if (request === "server-only") return {};
  if (request === "@/lib/cloud-logger") {
    return { cloudLog: () => {} };
  }
  return origLoad.call(this, request, parent, ...rest);
};

process.on("exit", () => {
  Module._load = origLoad;
});

function reload() {
  delete Module._cache[SUT_PATH];
  return require(SUT_PATH);
}

// ── Feature flag ──────────────────────────────────────────────────────────────

test("isAgentEngineSessionsEnabled: false by default", () => {
  delete process.env.USE_AGENT_ENGINE_SESSIONS;
  delete process.env.AGENT_ENGINE_RESOURCE_NAME;
  const { isAgentEngineSessionsEnabled } = reload();
  assert.equal(isAgentEngineSessionsEnabled(), false);
});

test("isAgentEngineSessionsEnabled: false with flag on but no resource name", () => {
  process.env.USE_AGENT_ENGINE_SESSIONS = "true";
  delete process.env.AGENT_ENGINE_RESOURCE_NAME;
  const { isAgentEngineSessionsEnabled } = reload();
  assert.equal(isAgentEngineSessionsEnabled(), false);
  delete process.env.USE_AGENT_ENGINE_SESSIONS;
});

test("isAgentEngineSessionsEnabled: true with flag + resource name", () => {
  process.env.USE_AGENT_ENGINE_SESSIONS = "true";
  process.env.AGENT_ENGINE_RESOURCE_NAME =
    "projects/my-gcp-project/locations/us-central1/reasoningEngines/abc";
  const { isAgentEngineSessionsEnabled } = reload();
  assert.equal(isAgentEngineSessionsEnabled(), true);
  delete process.env.USE_AGENT_ENGINE_SESSIONS;
  delete process.env.AGENT_ENGINE_RESOURCE_NAME;
});

// ── createSession ─────────────────────────────────────────────────────────────

test("createSession: posts to sessions endpoint and returns ADK session", async () => {
  const RESOURCE = "projects/my-gcp-project/locations/us-central1/reasoningEngines/abc";
  const origFetch = global.fetch;
  let captured = null;
  global.fetch = async (url, opts) => {
    captured = { url: String(url), body: JSON.parse(String(opts.body)) };
    return {
      ok: true,
      status: 200,
      async json() {
        return { name: `${RESOURCE}/sessions/sess-1`, userId: "user-1" };
      },
    };
  };

  const { VertexAgentEngineSessionService } = reload();
  const svc = new VertexAgentEngineSessionService(RESOURCE);
  const session = await svc.createSession({
    appName: "velora-supervisor-agent",
    userId: "user-1",
    sessionId: "sess-1",
  });

  assert.equal(session.id, "sess-1");
  assert.equal(session.userId, "user-1");
  assert.equal(session.appName, "velora-supervisor-agent");
  assert.ok(Array.isArray(session.events));
  assert.match(captured.url, /\/sessions$/);
  assert.equal(captured.body.userId, "user-1");
  assert.equal(captured.body.sessionId, "sess-1");

  global.fetch = origFetch;
});

test("createSession: API 5xx → returns synthetic session without throw", async () => {
  const RESOURCE = "projects/p/locations/us-central1/reasoningEngines/r";
  const origFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 503, async json() { return {}; } });

  const { VertexAgentEngineSessionService } = reload();
  const svc = new VertexAgentEngineSessionService(RESOURCE);
  const session = await svc.createSession({
    appName: "app",
    userId: "u1",
    sessionId: "s1",
  });

  // Graceful: returns a synthetic session despite API error.
  assert.equal(session.userId, "u1");
  assert.equal(session.id, "s1");

  global.fetch = origFetch;
});

// ── getSession ────────────────────────────────────────────────────────────────

test("getSession: GETs correct URL and maps AE events to ADK events", async () => {
  const RESOURCE = "projects/p/locations/us-central1/reasoningEngines/r";
  const origFetch = global.fetch;
  let capturedUrl = "";
  global.fetch = async (url) => {
    capturedUrl = String(url);
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          name: `${RESOURCE}/sessions/sess-42`,
          userId: "emp-1",
          updateTime: "2026-01-01T00:00:00Z",
          events: [
            {
              id: "ev-1",
              author: "user",
              content: { role: "user", parts: [{ text: "hola" }] },
              timestamp: "2026-01-01T00:00:00Z",
            },
          ],
        };
      },
    };
  };

  const { VertexAgentEngineSessionService } = reload();
  const svc = new VertexAgentEngineSessionService(RESOURCE);
  const session = await svc.getSession({
    appName: "app",
    userId: "emp-1",
    sessionId: "sess-42",
  });

  assert.ok(session, "expected session to be returned");
  assert.equal(session.id, "sess-42");
  assert.equal(session.events.length, 1);
  assert.equal(session.events[0].content?.parts?.[0]?.text, "hola");
  assert.match(capturedUrl, /\/sessions\/sess-42$/);

  global.fetch = origFetch;
});

test("getSession: 404 → undefined (session does not exist)", async () => {
  const RESOURCE = "projects/p/locations/us-central1/reasoningEngines/r";
  const origFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 404, async json() { return {}; } });

  const { VertexAgentEngineSessionService } = reload();
  const svc = new VertexAgentEngineSessionService(RESOURCE);
  const session = await svc.getSession({ appName: "a", userId: "u", sessionId: "missing" });
  assert.equal(session, undefined);

  global.fetch = origFetch;
});

// ── listSessions ──────────────────────────────────────────────────────────────

test("listSessions: GETs with userId filter and maps sessions", async () => {
  const RESOURCE = "projects/p/locations/us-central1/reasoningEngines/r";
  const origFetch = global.fetch;
  let capturedUrl = "";
  global.fetch = async (url) => {
    capturedUrl = String(url);
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          sessions: [
            { name: `${RESOURCE}/sessions/s1`, userId: "u1" },
            { name: `${RESOURCE}/sessions/s2`, userId: "u1" },
          ],
        };
      },
    };
  };

  const { VertexAgentEngineSessionService } = reload();
  const svc = new VertexAgentEngineSessionService(RESOURCE);
  const result = await svc.listSessions({ appName: "app", userId: "u1" });

  assert.equal(result.sessions.length, 2);
  assert.equal(result.sessions[0].id, "s1");
  assert.equal(result.sessions[1].id, "s2");
  assert.match(capturedUrl, /filter=userId/);

  global.fetch = origFetch;
});

test("listSessions: 5xx → empty list without throw", async () => {
  const RESOURCE = "projects/p/locations/us-central1/reasoningEngines/r";
  const origFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 500, async json() { return {}; } });

  const { VertexAgentEngineSessionService } = reload();
  const svc = new VertexAgentEngineSessionService(RESOURCE);
  const result = await svc.listSessions({ appName: "app", userId: "u1" });
  assert.deepEqual(result.sessions, []);

  global.fetch = origFetch;
});

// ── deleteSession ─────────────────────────────────────────────────────────────

test("deleteSession: DELETEs correct URL and resolves without throw", async () => {
  const RESOURCE = "projects/p/locations/us-central1/reasoningEngines/r";
  const origFetch = global.fetch;
  let capturedMethod = "";
  let capturedUrl = "";
  global.fetch = async (url, opts) => {
    capturedMethod = String(opts?.method);
    capturedUrl = String(url);
    return { ok: true, status: 204, async json() { return {}; } };
  };

  const { VertexAgentEngineSessionService } = reload();
  const svc = new VertexAgentEngineSessionService(RESOURCE);
  await assert.doesNotReject(() =>
    svc.deleteSession({ appName: "app", userId: "u", sessionId: "sess-to-delete" }),
  );
  assert.equal(capturedMethod, "DELETE");
  assert.match(capturedUrl, /\/sessions\/sess-to-delete$/);

  global.fetch = origFetch;
});

// ── appendEvent ───────────────────────────────────────────────────────────────

test("appendEvent: posts text event to /events endpoint and returns event", async () => {
  const RESOURCE = "projects/p/locations/us-central1/reasoningEngines/r";
  const origFetch = global.fetch;
  let capturedUrl = "";
  let capturedBody = null;
  global.fetch = async (url, opts) => {
    capturedUrl = String(url);
    capturedBody = JSON.parse(String(opts?.body));
    return { ok: true, status: 200, async json() { return {}; } };
  };

  const { VertexAgentEngineSessionService } = reload();
  const svc = new VertexAgentEngineSessionService(RESOURCE);

  const fakeSession = {
    id: "sess-99",
    appName: "app",
    userId: "u1",
    state: {},
    events: [],
    lastUpdateTime: Date.now() / 1000,
  };

  const fakeEvent = {
    id: "ev-abc",
    invocationId: "inv-1",
    author: "user",
    content: { role: "user", parts: [{ text: "hola mundo" }] },
    timestamp: Date.now() / 1000,
  };

  const returned = await svc.appendEvent({ session: fakeSession, event: fakeEvent });
  // Event is returned immediately (fire-and-forget POST runs in background).
  assert.deepEqual(returned, fakeEvent);

  // Wait a tick for the fire-and-forget to execute.
  await new Promise((r) => setImmediate(r));
  // POST /v1beta1/{session_name}:appendEvent — custom-method syntax required by
  // the Vertex AI Agent Engine REST spec (NOT /sessions/{id}/events sub-resource).
  assert.match(capturedUrl, /\/sessions\/sess-99:appendEvent$/);
  assert.equal(capturedBody?.content?.parts?.[0]?.text, "hola mundo");

  global.fetch = origFetch;
});

test("appendEvent: skips non-text events (tool call) without posting", async () => {
  const RESOURCE = "projects/p/locations/us-central1/reasoningEngines/r";
  const origFetch = global.fetch;
  let fetchCalled = false;
  global.fetch = async () => {
    fetchCalled = true;
    return { ok: true, status: 200, async json() { return {}; } };
  };

  const { VertexAgentEngineSessionService } = reload();
  const svc = new VertexAgentEngineSessionService(RESOURCE);

  const fakeSession = { id: "s", appName: "a", userId: "u", state: {}, events: [], lastUpdateTime: 0 };
  // Tool call event — no text parts
  const toolEvent = {
    id: "tool-ev",
    invocationId: "inv-2",
    author: "model",
    content: { role: "model", parts: [{ functionCall: { name: "check_stock", args: {} } }] },
    timestamp: Date.now() / 1000,
  };

  await svc.appendEvent({ session: fakeSession, event: toolEvent });
  await new Promise((r) => setImmediate(r));
  assert.equal(fetchCalled, false, "should not POST for tool call events");

  global.fetch = origFetch;
});
