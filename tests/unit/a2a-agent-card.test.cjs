const assert = require("node:assert/strict");
const test = require("node:test");

const { GET } = require("../../src/app/api/a2a/agent-card/route.ts");

function makeRequest(host = "somosvelora.com", proto = "https") {
  return {
    headers: {
      get: (name) => {
        if (name === "x-forwarded-proto") return proto;
        if (name === "host") return host;
        return null;
      },
    },
  };
}

test("agent-card: returns valid A2A v0.3.x card with required fields", async () => {
  const res = GET(makeRequest());
  const card = await res.json();

  assert.equal(card.protocolVersion, "0.3.0");
  assert.equal(typeof card.name, "string");
  assert.equal(typeof card.description, "string");
  assert.equal(typeof card.version, "string");
  assert.equal(typeof card.url, "string");
  assert.ok(card.url.startsWith("https://"));
  assert.ok(Array.isArray(card.skills));
  assert.ok(card.skills.length > 0);
  assert.ok(Array.isArray(card.defaultInputModes));
  assert.ok(Array.isArray(card.defaultOutputModes));
  assert.equal(typeof card.capabilities, "object");
});

test("agent-card: url is the canonical somosvelora.com regardless of host", async () => {
  // Agent card baseUrl is hardcoded so peer A2A agents see ONE stable
  // address even if the card was discovered via .run.app or www.
  const res = GET(makeRequest("custom.example.com"));
  const card = await res.json();
  assert.equal(card.url, "https://somosvelora.com/api/a2a/jsonrpc");
});

test("agent-card: A2A_PUBLIC_BASE_URL env override wins (read at runtime)", async () => {
  process.env.A2A_PUBLIC_BASE_URL = "https://staging.somosvelora.com";
  const res = GET(makeRequest());
  const card = await res.json();
  assert.equal(card.url, "https://staging.somosvelora.com/api/a2a/jsonrpc");
  delete process.env.A2A_PUBLIC_BASE_URL;
});

test("agent-card: declares ApiKeyAuth security scheme", async () => {
  const res = GET(makeRequest());
  const card = await res.json();
  assert.equal(card.securitySchemes.ApiKeyAuth.type, "apiKey");
  assert.equal(card.securitySchemes.ApiKeyAuth.name, "X-API-Key");
  assert.equal(card.securitySchemes.ApiKeyAuth.in, "header");
  assert.deepEqual(card.security, [{ ApiKeyAuth: [] }]);
});

test("agent-card: supervisor skill has examples in Spanish", async () => {
  const res = GET(makeRequest());
  const card = await res.json();
  const supervisor = card.skills.find((s) => s.id === "supervisor");
  assert.ok(supervisor);
  assert.ok(Array.isArray(supervisor.examples));
  assert.ok(supervisor.examples.length >= 3);
  // Sanity: examples are in Spanish (rioplatense)
  const allText = supervisor.examples.join(" ").toLowerCase();
  assert.ok(/vend|stock|deb|caja/.test(allText), "expected commerce-domain examples");
});

test("agent-card: capabilities reflect MVP (no streaming, no push)", async () => {
  const res = GET(makeRequest());
  const card = await res.json();
  assert.equal(card.capabilities.streaming, false);
  assert.equal(card.capabilities.pushNotifications, false);
});

test("agent-card: includes provider and version metadata", async () => {
  const res = GET(makeRequest());
  const card = await res.json();
  assert.equal(card.provider.organization, "Velora");
  assert.ok(card.provider.url);
  assert.ok(card.version);
});
