// tests/vitest/mcp/oauth-auth.test.ts
//
// Tests for Velora's OAuth 2.1 Resource Server implementation (RFC 9728 + RFC 8707).
//
// Covers:
//   1. .well-known/oauth-protected-resource — correct metadata shape.
//   2. MCP route: no auth → 401 with WWW-Authenticate header.
//   3. HMAC path (dual auth) — still works, businessId resolved from headers.
//   4. Bearer path: valid token → businessId from email; wrong aud → 401;
//      expired/bad sig → 401; valid token + no Velora business → 403;
//      WorkOS env unset → 401 "OAUTH_NOT_CONFIGURED" (HMAC still works).
//
// jose and @/lib/prisma are mocked — no network, no DB.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Hoisted mocks (must run before module graph resolution) ──────────────────

const { jwtVerifyMock, prismaMock, provisionTenantMock } = vi.hoisted(() => ({
  jwtVerifyMock: vi.fn(),
  prismaMock: {
    user: {
      findUnique: vi.fn(),
    },
  },
  provisionTenantMock: vi.fn(),
}));

// Mock jose — replace jwtVerify + createRemoteJWKSet so no real JWKS is fetched.
vi.mock("jose", () => ({
  jwtVerify: jwtVerifyMock,
  createRemoteJWKSet: vi.fn(() => "mock-jwks-keyset"),
}));

// Mock Prisma so we control the User → Business lookup.
vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));

// Mock cloud-logger — avoids structured log side-effects in tests.
vi.mock("@/lib/cloud-logger", () => ({
  reportWarning: vi.fn(),
  cloudLog: vi.fn(),
}));

// Mock JIT provisioning — prevents PrismaAdapter from being constructed in
// oauth-verify tests; lets us control provisioning outcomes explicitly.
vi.mock("@/lib/mcp/_lib/jit-provision-tenant", () => ({
  provisionTenantForWorkosUser: provisionTenantMock,
  EmailAlreadyRegisteredError: class EmailAlreadyRegisteredError extends Error {
    constructor(email: string) {
      super(`email already registered: ${email}`);
      this.name = "EmailAlreadyRegisteredError";
    }
  },
}));

// Mock the A2A auth so we can control HMAC verification.
const { verifyA2AApiKeyForTenantMock } = vi.hoisted(() => ({
  verifyA2AApiKeyForTenantMock: vi.fn(),
}));
vi.mock("@/app/api/agents/_lib/a2a-auth", () => ({
  verifyA2AApiKeyForTenant: verifyA2AApiKeyForTenantMock,
}));

// Mock buildVeloraMcpServer — we're testing auth, not tool dispatch.
// The function is async (returns Promise<McpServer>) so the mock must resolve.
vi.mock("@/lib/mcp/server", () => ({
  buildVeloraMcpServer: vi.fn().mockResolvedValue({
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  }),
}));

// Mock the MCP transport so handleRequest returns a trivial 200.
// Must use a class (constructor function) — vi.fn().mockImplementation returns a
// plain function which fails `new WebStandardStreamableHTTPServerTransport(...)`.
vi.mock("@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js", () => {
  class MockTransport {
    handleRequest() {
      return Promise.resolve(new Response("{}", { status: 200 }));
    }
  }
  return { WebStandardStreamableHTTPServerTransport: MockTransport };
});

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { verifyBearerToken, MCP_RESOURCE_URI } from "@/lib/mcp/oauth-verify";

// ── Helpers ───────────────────────────────────────────────────────────────────

const WORKOS_JWKS_URL = "https://auth.example.workos.com/oauth2/jwks";
const WORKOS_AS_ISSUER = "https://auth.example.workos.com";
const WORKOS_AS_METADATA_URL =
  "https://auth.example.workos.com/.well-known/oauth-authorization-server";
const TEST_RESOURCE_URI = "https://tools.somosvelora.com/api/mcp";
const VELORA_APP_URL = "https://tools.somosvelora.com";

function setWorkOsEnv() {
  process.env.WORKOS_JWKS_URL = WORKOS_JWKS_URL;
  process.env.WORKOS_AS_ISSUER = WORKOS_AS_ISSUER;
  process.env.WORKOS_AS_METADATA_URL = WORKOS_AS_METADATA_URL;
  process.env.MCP_RESOURCE_URI = TEST_RESOURCE_URI;
  process.env.VELORA_APP_URL = VELORA_APP_URL;
}

function clearWorkOsEnv() {
  delete process.env.WORKOS_JWKS_URL;
  delete process.env.WORKOS_AS_ISSUER;
  delete process.env.WORKOS_AS_METADATA_URL;
  delete process.env.MCP_RESOURCE_URI;
}

// ── 1. .well-known/oauth-protected-resource ───────────────────────────────────

describe(".well-known/oauth-protected-resource route", () => {
  afterEach(() => {
    clearWorkOsEnv();
    vi.clearAllMocks();
  });

  it("returns correct resource + authorization_servers when configured", async () => {
    setWorkOsEnv();
    // Import the route handler dynamically after env is set.
    const { GET } = await import(
      "@/app/.well-known/oauth-protected-resource/[[...path]]/route"
    );
    const response = GET();
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.resource).toBe(TEST_RESOURCE_URI);
    // RFC 9728 §2: authorization_servers carries the ISSUER identifier, not the
    // .well-known metadata URL (clients derive the metadata URL from the issuer).
    expect(body.authorization_servers).toEqual([WORKOS_AS_ISSUER]);
  });

  it("returns Cache-Control header when configured", async () => {
    setWorkOsEnv();
    const { GET } = await import(
      "@/app/.well-known/oauth-protected-resource/[[...path]]/route"
    );
    const response = GET();
    expect(response.headers.get("Cache-Control")).toContain("max-age=300");
  });

  it("returns 503 OAUTH_NOT_CONFIGURED when WORKOS_AS_ISSUER is unset (fail-closed)", async () => {
    // Ensure WORKOS_AS_ISSUER is not set (other env vars may be present) — the
    // well-known route now keys its fail-closed guard on the issuer, not the
    // metadata URL.
    delete process.env.WORKOS_AS_ISSUER;
    const { GET } = await import(
      "@/app/.well-known/oauth-protected-resource/[[...path]]/route"
    );
    const response = GET();
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.code).toBe("OAUTH_NOT_CONFIGURED");
    expect(typeof body.message).toBe("string");
  });
});

// ── 2 + 3. Bearer token verification (verifyBearerToken) ─────────────────────

describe("verifyBearerToken — WorkOS env not configured", () => {
  beforeEach(() => {
    clearWorkOsEnv();
    vi.clearAllMocks();
  });

  it("returns 401 OAUTH_NOT_CONFIGURED when WORKOS_JWKS_URL is unset", async () => {
    const result = await verifyBearerToken("Bearer some.token.here");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
      expect(result.code).toBe("OAUTH_NOT_CONFIGURED");
    }
  });

  it("returns 401 OAUTH_NOT_CONFIGURED when WORKOS_AS_ISSUER is unset", async () => {
    process.env.WORKOS_JWKS_URL = WORKOS_JWKS_URL;
    // Issuer missing → should still fail-closed
    const result = await verifyBearerToken("Bearer some.token.here");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
      expect(result.code).toBe("OAUTH_NOT_CONFIGURED");
    }
    delete process.env.WORKOS_JWKS_URL;
  });
});

describe("verifyBearerToken — WorkOS env configured", () => {
  beforeEach(() => {
    setWorkOsEnv();
    vi.clearAllMocks();
  });

  afterEach(() => {
    clearWorkOsEnv();
  });

  it("returns ok + businessId for a valid token with matching aud", async () => {
    jwtVerifyMock.mockResolvedValue({
      payload: {
        iss: WORKOS_AS_ISSUER,
        aud: TEST_RESOURCE_URI,
        sub: "user_abc123",
        email: "owner@velora.com",
        email_verified: true,
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
    });
    prismaMock.user.findUnique.mockResolvedValue({
      business: { id: "biz-001" },
    });

    const result = await verifyBearerToken("Bearer valid.jwt.token");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.businessId).toBe("biz-001");
    }
  });

  it("returns 401 UNVERIFIED_EMAIL when email_verified is false", async () => {
    // Mirrors the guard in auth-signin-callback.ts (L63) — non-Google IdPs may
    // issue tokens with unverified emails; this must be rejected before DB lookup.
    jwtVerifyMock.mockResolvedValue({
      payload: {
        iss: WORKOS_AS_ISSUER,
        aud: TEST_RESOURCE_URI,
        sub: "user_unverified",
        email: "unverified@example.com",
        email_verified: false,
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
    });

    const result = await verifyBearerToken("Bearer unverified.email.token");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
      expect(result.code).toBe("UNVERIFIED_EMAIL");
    }
    // DB must NOT be queried — rejected before tenant lookup
    expect(prismaMock.user.findUnique).not.toHaveBeenCalled();
  });

  it("returns 401 UNVERIFIED_EMAIL when email_verified claim is absent", async () => {
    jwtVerifyMock.mockResolvedValue({
      payload: {
        iss: WORKOS_AS_ISSUER,
        aud: TEST_RESOURCE_URI,
        sub: "user_no_verified_claim",
        email: "nofield@example.com",
        exp: Math.floor(Date.now() / 1000) + 3600,
        // email_verified intentionally omitted
      },
    });

    const result = await verifyBearerToken("Bearer no.verified.claim.token");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
      expect(result.code).toBe("UNVERIFIED_EMAIL");
    }
    expect(prismaMock.user.findUnique).not.toHaveBeenCalled();
  });

  it("returns 401 INVALID_TOKEN when token has no exp claim (requiredClaims:[exp])", async () => {
    // jose throws when a required claim is missing — simulate that behavior.
    jwtVerifyMock.mockRejectedValue(
      new Error('missing required "exp" claim'),
    );

    const result = await verifyBearerToken("Bearer no.exp.token");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
      expect(result.code).toBe("INVALID_TOKEN");
    }
  });

  it("requiredClaims option is passed to jwtVerify (exp + sub both enforced)", async () => {
    // Assert that the jwtVerify call includes requiredClaims: ["exp", "sub"] (Fix 3).
    // A token missing sub must be rejected before it reaches provisioning.
    jwtVerifyMock.mockResolvedValue({
      payload: {
        iss: WORKOS_AS_ISSUER,
        aud: TEST_RESOURCE_URI,
        sub: "user_opt_check",
        email: "owner@velora.com",
        email_verified: true,
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
    });
    prismaMock.user.findUnique.mockResolvedValue({
      business: { id: "biz-opt" },
    });

    await verifyBearerToken("Bearer options.check.token");

    // Verify the third argument (options) passed to jwtVerify includes requiredClaims.
    const callOptions = jwtVerifyMock.mock.calls[0][2];
    expect(callOptions).toMatchObject({ requiredClaims: expect.arrayContaining(["exp", "sub"]) });
  });

  it("returns 401 INVALID_TOKEN when jwtVerify throws (wrong audience)", async () => {
    jwtVerifyMock.mockRejectedValue(
      new Error('unexpected "aud" claim value'),
    );

    const result = await verifyBearerToken("Bearer wrong.aud.token");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
      expect(result.code).toBe("INVALID_TOKEN");
    }
  });

  it("returns 401 INVALID_TOKEN when jwtVerify throws (expired)", async () => {
    jwtVerifyMock.mockRejectedValue(new Error('"exp" claim timestamp check failed'));

    const result = await verifyBearerToken("Bearer expired.jwt.token");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
      expect(result.code).toBe("INVALID_TOKEN");
    }
  });

  it("returns 401 INVALID_TOKEN when jwtVerify throws (bad signature)", async () => {
    jwtVerifyMock.mockRejectedValue(new Error("signature verification failed"));

    const result = await verifyBearerToken("Bearer bad.sig.token");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
      expect(result.code).toBe("INVALID_TOKEN");
    }
  });

  it("JIT provisioning succeeds when user has no business — returns ok + new businessId", async () => {
    // User exists but has no business → JIT provision is called → succeeds.
    jwtVerifyMock.mockResolvedValue({
      payload: {
        iss: WORKOS_AS_ISSUER,
        aud: TEST_RESOURCE_URI,
        sub: "user_no_biz",
        email: "stranger@example.com",
        email_verified: true,
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
    });
    prismaMock.user.findUnique.mockResolvedValue({ business: null });
    provisionTenantMock.mockResolvedValue("biz-jit-new");

    const result = await verifyBearerToken("Bearer valid.no-biz.token");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.businessId).toBe("biz-jit-new");
    }
    expect(provisionTenantMock).toHaveBeenCalledWith(
      expect.objectContaining({ email: "stranger@example.com", sub: "user_no_biz" }),
    );
  });

  it("JIT provisioning succeeds when email is not in DB — returns ok + new businessId", async () => {
    // Email unknown → JIT provision is called → succeeds (self-serve new user).
    jwtVerifyMock.mockResolvedValue({
      payload: {
        iss: WORKOS_AS_ISSUER,
        aud: TEST_RESOURCE_URI,
        sub: "user_ghost",
        email: "ghost@example.com",
        email_verified: true,
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
    });
    prismaMock.user.findUnique.mockResolvedValue(null);
    provisionTenantMock.mockResolvedValue("biz-jit-ghost");

    const result = await verifyBearerToken("Bearer valid.ghost.token");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.businessId).toBe("biz-jit-ghost");
    }
  });

  it("returns 403 ACCOUNT_NEEDS_LINKING when JIT provisioning is refused (cross-provider, Fix 1)", async () => {
    // JIT provisioning throws EmailAlreadyRegisteredError → 403 ACCOUNT_NEEDS_LINKING.
    jwtVerifyMock.mockResolvedValue({
      payload: {
        iss: WORKOS_AS_ISSUER,
        aud: TEST_RESOURCE_URI,
        sub: "user_cross_provider",
        email: "existing@velora.com",
        email_verified: true,
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
    });
    prismaMock.user.findUnique.mockResolvedValue(null); // triggers JIT path

    // Simulate EmailAlreadyRegisteredError from jit-provision-tenant
    const { EmailAlreadyRegisteredError } = await import(
      "@/lib/mcp/_lib/jit-provision-tenant"
    );
    provisionTenantMock.mockRejectedValue(
      new EmailAlreadyRegisteredError("existing@velora.com"),
    );

    const result = await verifyBearerToken("Bearer cross.provider.token");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(403);
      expect(result.code).toBe("ACCOUNT_NEEDS_LINKING");
    }
  });

  it("returns 500 PROVISIONING_ERROR when JIT provisioning fails with a server error (Fix 4)", async () => {
    // JIT provisioning throws a generic DB error → 500 PROVISIONING_ERROR.
    jwtVerifyMock.mockResolvedValue({
      payload: {
        iss: WORKOS_AS_ISSUER,
        aud: TEST_RESOURCE_URI,
        sub: "user_db_error",
        email: "dberror@example.com",
        email_verified: true,
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
    });
    prismaMock.user.findUnique.mockResolvedValue(null); // triggers JIT path
    provisionTenantMock.mockRejectedValue(new Error("DB connection error"));

    const result = await verifyBearerToken("Bearer db.error.token");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(500);
      expect(result.code).toBe("PROVISIONING_ERROR");
    }
  });

  it("returns 401 UNAUTHORIZED when Authorization header is absent", async () => {
    const result = await verifyBearerToken(null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // OAUTH_NOT_CONFIGURED takes priority when env is set — but here env IS set,
      // so we expect UNAUTHORIZED from the missing header check.
      expect(result.status).toBe(401);
    }
  });

  it("returns 401 when email claim is missing from token payload", async () => {
    jwtVerifyMock.mockResolvedValue({
      payload: {
        iss: WORKOS_AS_ISSUER,
        aud: TEST_RESOURCE_URI,
        sub: "user_no_email",
        exp: Math.floor(Date.now() / 1000) + 3600,
        // no email field
      },
    });

    const result = await verifyBearerToken("Bearer no.email.token");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
      expect(result.code).toBe("INVALID_TOKEN");
    }
  });
});

// ── 4. MCP Route: dual auth integration ───────────────────────────────────────

describe("MCP route dual auth", () => {
  beforeEach(() => {
    setWorkOsEnv();
    vi.clearAllMocks();
  });

  afterEach(() => {
    clearWorkOsEnv();
  });

  async function callMcpRoute(
    headers: Record<string, string>,
  ): Promise<Response> {
    const { POST } = await import(
      "@/app/api/mcp/route"
    );
    const req = new Request("https://tools.somosvelora.com/api/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
      }),
    });
    // NextRequest wraps a standard Request
    const { NextRequest } = await import("next/server");
    return POST(new NextRequest(req));
  }

  it("returns 401 with WWW-Authenticate when no auth is provided", async () => {
    verifyA2AApiKeyForTenantMock.mockReturnValue(false);

    const response = await callMcpRoute({ "content-type": "application/json" });
    expect(response.status).toBe(401);
    const wwwAuth = response.headers.get("WWW-Authenticate");
    expect(wwwAuth).toBeTruthy();
    expect(wwwAuth).toContain("Bearer resource_metadata=");
    expect(wwwAuth).toContain(".well-known/oauth-protected-resource");
  });

  it("HMAC path: valid X-API-Key + X-Business-Id succeeds (dual auth — Claude Code unbroken)", async () => {
    // HMAC check passes
    verifyA2AApiKeyForTenantMock.mockReturnValue(true);

    const response = await callMcpRoute({
      "content-type": "application/json",
      "x-api-key": "valid-hmac-key",
      "x-business-id": "biz-hmac-001",
    });
    // Rate limiter + transport mock returns 200
    expect(response.status).toBe(200);
    // HMAC path must NOT require WorkOS env — verify it works even with WorkOS unset
    expect(verifyA2AApiKeyForTenantMock).toHaveBeenCalled();
  });

  it("Bearer path: valid token resolves businessId from email", async () => {
    verifyA2AApiKeyForTenantMock.mockReturnValue(false); // HMAC fails → try Bearer

    jwtVerifyMock.mockResolvedValue({
      payload: {
        iss: WORKOS_AS_ISSUER,
        aud: TEST_RESOURCE_URI,
        sub: "user_bearer",
        email: "owner@velora.com",
        email_verified: true,
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
    });
    prismaMock.user.findUnique.mockResolvedValue({
      business: { id: "biz-bearer-001" },
    });

    const response = await callMcpRoute({
      "content-type": "application/json",
      authorization: "Bearer valid.jwt.token",
    });
    expect(response.status).toBe(200);
  });

  it("Bearer path: wrong audience → 401 with WWW-Authenticate", async () => {
    verifyA2AApiKeyForTenantMock.mockReturnValue(false);
    jwtVerifyMock.mockRejectedValue(new Error('unexpected "aud" claim value'));

    const response = await callMcpRoute({
      "content-type": "application/json",
      authorization: "Bearer wrong.aud.token",
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toBeTruthy();
  });

  it("Bearer path: valid token + no Velora business → JIT provisioned → 200 with new businessId", async () => {
    // With JIT provisioning, a verified user with no business is now provisioned on first login.
    verifyA2AApiKeyForTenantMock.mockReturnValue(false);
    jwtVerifyMock.mockResolvedValue({
      payload: {
        iss: WORKOS_AS_ISSUER,
        aud: TEST_RESOURCE_URI,
        sub: "user_no_biz",
        email: "stranger@example.com",
        email_verified: true,
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
    });
    prismaMock.user.findUnique.mockResolvedValue(null); // triggers JIT path
    provisionTenantMock.mockResolvedValue("biz-jit-route-001");

    const response = await callMcpRoute({
      "content-type": "application/json",
      authorization: "Bearer valid.but.no-biz.token",
    });
    // JIT provisioning succeeded → request continues to tool dispatch → 200.
    expect(response.status).toBe(200);
  });

  it("Bearer path: valid token + JIT provisioning server error → 500 (not 401/403, Fix 4)", async () => {
    verifyA2AApiKeyForTenantMock.mockReturnValue(false);
    jwtVerifyMock.mockResolvedValue({
      payload: {
        iss: WORKOS_AS_ISSUER,
        aud: TEST_RESOURCE_URI,
        sub: "user_db_fail",
        email: "dberror@example.com",
        email_verified: true,
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
    });
    prismaMock.user.findUnique.mockResolvedValue(null);
    provisionTenantMock.mockRejectedValue(new Error("DB connection error"));

    const response = await callMcpRoute({
      "content-type": "application/json",
      authorization: "Bearer db.error.token",
    });
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.code).toBe("PROVISIONING_ERROR");
  });

  it("WorkOS env unset → Bearer returns 401 OAUTH_NOT_CONFIGURED; HMAC still works", async () => {
    clearWorkOsEnv(); // unset all WorkOS vars

    // HMAC path: still works when WorkOS is not configured
    verifyA2AApiKeyForTenantMock.mockReturnValue(true);
    const hmacResponse = await callMcpRoute({
      "content-type": "application/json",
      "x-api-key": "valid-hmac-key",
      "x-business-id": "biz-hmac-002",
    });
    expect(hmacResponse.status).toBe(200);

    // Bearer path: fails with OAUTH_NOT_CONFIGURED when env is unset
    verifyA2AApiKeyForTenantMock.mockReturnValue(false);
    const bearerResponse = await callMcpRoute({
      "content-type": "application/json",
      authorization: "Bearer some.token",
    });
    expect(bearerResponse.status).toBe(401);
    const body = await bearerResponse.json();
    expect(body.code).toBe("OAUTH_NOT_CONFIGURED");
  });
});

// ── 5. MCP_RESOURCE_URI export ─────────────────────────────────────────────────

describe("MCP_RESOURCE_URI", () => {
  it("defaults to tools.somosvelora.com canonical URI", () => {
    // When MCP_RESOURCE_URI env var is not set, verify the fallback
    const savedEnv = process.env.MCP_RESOURCE_URI;
    delete process.env.MCP_RESOURCE_URI;
    // The module-level const was already evaluated — this tests the default in source.
    // We assert the exported value matches the expected production URI.
    expect(MCP_RESOURCE_URI).toMatch(/^https:\/\//);
    expect(MCP_RESOURCE_URI).toContain("somosvelora.com");
    if (savedEnv) process.env.MCP_RESOURCE_URI = savedEnv;
  });
});
