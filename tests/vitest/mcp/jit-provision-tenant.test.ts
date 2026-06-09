// tests/vitest/mcp/jit-provision-tenant.test.ts
//
// Unit tests for the JIT tenant provisioning helper.
//
// Cases:
//   (a) New sub + email → creates User, links Account, creates Business; returns businessId.
//   (b) Existing account (sub already linked) → idempotent; returns existing businessId.
//   (b2) Existing account (sub already linked) with a changed email → returns the EXISTING
//        user's business via sub (email-drift handled, no new business created).
//   (c) Existing email but new sub → REFUSED (cross-provider auto-merge is an account
//       takeover vector — Auth.js OAuthAccountNotLinked standard). createUser + linkAccount
//       must NOT be called; EmailAlreadyRegisteredError thrown.
//   (d) P2002 on createUser → recovers via re-fetch and returns the winner's business.
//   (e) P2002 on linkAccount → recovers via re-fetch (getUserByAccount) and returns business.
//
// All external dependencies (PrismaAdapter, prisma, ensurePlaceholderBusiness,
// cloudLog) are mocked — no DB, no network.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const {
  getUserByAccountMock,
  getUserByEmailMock,
  createUserMock,
  linkAccountMock,
  prismaBizFindUniqueMock,
  ensurePlaceholderBusinessMock,
} = vi.hoisted(() => ({
  getUserByAccountMock: vi.fn(),
  getUserByEmailMock: vi.fn(),
  createUserMock: vi.fn(),
  linkAccountMock: vi.fn(),
  prismaBizFindUniqueMock: vi.fn(),
  ensurePlaceholderBusinessMock: vi.fn(),
}));

// Mock @auth/prisma-adapter — return a controlled adapter object.
vi.mock("@auth/prisma-adapter", () => ({
  PrismaAdapter: vi.fn(() => ({
    getUserByAccount: getUserByAccountMock,
    getUserByEmail: getUserByEmailMock,
    createUser: createUserMock,
    linkAccount: linkAccountMock,
  })),
}));

// Mock @/lib/prisma — we only need business.findUnique.
vi.mock("@/lib/prisma", () => ({
  prisma: {
    business: { findUnique: prismaBizFindUniqueMock },
  },
}));

// Mock ensurePlaceholderBusiness — canonical Business-creation path.
vi.mock("@/app/api/onboarding/_lib/business-recovery", () => ({
  ensurePlaceholderBusiness: ensurePlaceholderBusinessMock,
}));

// Mock cloud-logger.
vi.mock("@/lib/cloud-logger", () => ({
  cloudLog: vi.fn(),
  reportWarning: vi.fn(),
}));

// ── Import SUT (after mocks) ──────────────────────────────────────────────────

import {
  provisionTenantForWorkosUser,
  EmailAlreadyRegisteredError,
} from "@/lib/mcp/_lib/jit-provision-tenant";

// ── Helpers ───────────────────────────────────────────────────────────────────

const INPUT = {
  sub: "workos_user_abc123",
  email: "owner@example.com",
  emailVerified: true,
} as const;

const MOCK_USER_NEW = { id: "user-new-001", email: INPUT.email, emailVerified: new Date(), name: null, image: null };
const MOCK_USER_EXISTING = { id: "user-existing-002", email: INPUT.email, emailVerified: new Date(), name: null, image: null };
const BIZ_ID = "biz-jit-001";

// P2002 Prisma error shape
function p2002Error(): { code: string; message: string } {
  return { code: "P2002", message: "Unique constraint failed" };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("provisionTenantForWorkosUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: ensurePlaceholderBusiness resolves cleanly.
    ensurePlaceholderBusinessMock.mockResolvedValue(undefined);
  });

  // ── (a) New sub + email → full provisioning path ──────────────────────────

  it("(a) new sub + new email: creates User, links Account, provisions Business, returns businessId", async () => {
    getUserByAccountMock.mockResolvedValue(null);   // sub not linked
    getUserByEmailMock.mockResolvedValue(null);      // email unknown
    createUserMock.mockResolvedValue(MOCK_USER_NEW);
    linkAccountMock.mockResolvedValue(undefined);
    prismaBizFindUniqueMock.mockResolvedValue({ id: BIZ_ID });

    const result = await provisionTenantForWorkosUser(INPUT);

    expect(result).toBe(BIZ_ID);

    // Adapter calls
    expect(getUserByAccountMock).toHaveBeenCalledWith({
      provider: "workos",
      providerAccountId: INPUT.sub,
    });
    expect(getUserByEmailMock).toHaveBeenCalledWith(INPUT.email);
    expect(createUserMock).toHaveBeenCalledWith(
      expect.objectContaining({ email: INPUT.email, emailVerified: expect.any(Date) }),
    );
    expect(linkAccountMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: MOCK_USER_NEW.id,
        provider: "workos",
        providerAccountId: INPUT.sub,
        type: "oauth",
      }),
    );

    // No raw prisma.user upsert — only business.findUnique after ensurePlaceholderBusiness
    expect(ensurePlaceholderBusinessMock).toHaveBeenCalledWith(MOCK_USER_NEW.id);
    expect(prismaBizFindUniqueMock).toHaveBeenCalledWith({
      where: { userId: MOCK_USER_NEW.id },
      select: { id: true },
    });
  });

  // ── (b) Existing account → idempotent return ──────────────────────────────

  it("(b) existing account (sub already linked): skips create/linkAccount, returns existing businessId", async () => {
    // Account already linked → getUserByAccount returns the User directly.
    getUserByAccountMock.mockResolvedValue(MOCK_USER_EXISTING);
    prismaBizFindUniqueMock.mockResolvedValue({ id: BIZ_ID });

    const result = await provisionTenantForWorkosUser(INPUT);

    expect(result).toBe(BIZ_ID);

    // getUserByEmail and createUser must NOT be called when account is already linked.
    expect(getUserByEmailMock).not.toHaveBeenCalled();
    expect(createUserMock).not.toHaveBeenCalled();
    expect(linkAccountMock).not.toHaveBeenCalled();

    // Business path still runs (idempotent).
    expect(ensurePlaceholderBusinessMock).toHaveBeenCalledWith(MOCK_USER_EXISTING.id);
  });

  // ── (b2) Existing account with a changed email → still resolved via sub ───

  it("(b2) existing account sub found — email drift is irrelevant, returns existing businessId via sub", async () => {
    // Simulate that the user's email changed: getUserByAccount still returns the
    // user (anchored to sub), regardless of what email the token now carries.
    const userWithDifferentEmail = { ...MOCK_USER_EXISTING, email: "newemail@example.com" };
    getUserByAccountMock.mockResolvedValue(userWithDifferentEmail);
    prismaBizFindUniqueMock.mockResolvedValue({ id: BIZ_ID });

    const result = await provisionTenantForWorkosUser({
      ...INPUT,
      email: "newemail@example.com",
    });

    expect(result).toBe(BIZ_ID);

    // No email lookup, no createUser — the sub account was found directly.
    expect(getUserByEmailMock).not.toHaveBeenCalled();
    expect(createUserMock).not.toHaveBeenCalled();
    expect(linkAccountMock).not.toHaveBeenCalled();

    // Returned business belongs to the existing user (no new business created).
    expect(ensurePlaceholderBusinessMock).toHaveBeenCalledWith(userWithDifferentEmail.id);
    expect(prismaBizFindUniqueMock).toHaveBeenCalledWith({
      where: { userId: userWithDifferentEmail.id },
      select: { id: true },
    });
  });

  // ── (c) Cross-provider merge REFUSED (Fix 1 — security) ───────────────────
  // Previous behavior (auto-link the account) was an account takeover vector.
  // Auth.js standard: OAuthAccountNotLinked — refuse, don't auto-merge.

  it("(c) existing email + new sub: REFUSES cross-provider auto-merge, throws EmailAlreadyRegisteredError", async () => {
    getUserByAccountMock.mockResolvedValue(null);             // sub not linked
    getUserByEmailMock.mockResolvedValue(MOCK_USER_EXISTING); // but email exists (different provider)

    await expect(provisionTenantForWorkosUser(INPUT)).rejects.toThrow(
      EmailAlreadyRegisteredError,
    );
    await expect(provisionTenantForWorkosUser(INPUT)).rejects.toThrow(
      /different sign-in method/,
    );

    // createUser and linkAccount must NOT be called — refuse before reaching them.
    expect(createUserMock).not.toHaveBeenCalled();
    expect(linkAccountMock).not.toHaveBeenCalled();

    // ensurePlaceholderBusiness must NOT be called — access denied.
    expect(ensurePlaceholderBusinessMock).not.toHaveBeenCalled();
  });

  // ── (d) Genuinely new email: createUser + linkAccount + business ───────────

  it("(d) genuinely new email: createUser + linkAccount called, returned businessId belongs to NEW user", async () => {
    getUserByAccountMock.mockResolvedValue(null);
    getUserByEmailMock.mockResolvedValue(null);
    createUserMock.mockResolvedValue(MOCK_USER_NEW);
    linkAccountMock.mockResolvedValue(undefined);
    prismaBizFindUniqueMock.mockResolvedValue({ id: BIZ_ID });

    const result = await provisionTenantForWorkosUser(INPUT);

    expect(result).toBe(BIZ_ID);
    // Confirm the business lookup used the NEW user's id (not any existing user).
    expect(prismaBizFindUniqueMock).toHaveBeenCalledWith({
      where: { userId: MOCK_USER_NEW.id },
      select: { id: true },
    });
    expect(ensurePlaceholderBusinessMock).toHaveBeenCalledWith(MOCK_USER_NEW.id);
  });

  // ── (e) P2002 on createUser → recover via re-fetch ────────────────────────
  // Fix 2: concurrent first-login race on createUser; recover by re-fetching the
  // winning user and continuing to ensurePlaceholderBusiness.

  it("(e) P2002 on createUser: recovers via getUserByAccount re-fetch, returns winner's businessId", async () => {
    getUserByAccountMock
      .mockResolvedValueOnce(null)          // first call: sub not yet linked
      .mockResolvedValueOnce(MOCK_USER_EXISTING); // second call (post-P2002): winner found

    getUserByEmailMock.mockResolvedValue(null); // email unknown at start
    createUserMock.mockRejectedValueOnce(p2002Error()); // concurrent winner already created the row
    prismaBizFindUniqueMock.mockResolvedValue({ id: BIZ_ID });

    const result = await provisionTenantForWorkosUser(INPUT);

    expect(result).toBe(BIZ_ID);

    // createUser was attempted once and failed — the race winner handled it.
    expect(createUserMock).toHaveBeenCalledTimes(1);

    // linkAccount must NOT be called for the recovered user (winner already linked).
    expect(linkAccountMock).not.toHaveBeenCalled();

    // ensurePlaceholderBusiness called with the winner's userId.
    expect(ensurePlaceholderBusinessMock).toHaveBeenCalledWith(MOCK_USER_EXISTING.id);
  });

  it("(e2) P2002 on createUser: recovers via getUserByEmail when getUserByAccount returns null post-race", async () => {
    // Edge: concurrent winner created User + but NOT linkAccount yet.
    getUserByAccountMock
      .mockResolvedValueOnce(null)   // first call
      .mockResolvedValueOnce(null);  // second call — account not linked yet by winner

    getUserByEmailMock
      .mockResolvedValueOnce(null)            // initial lookup: email unknown
      .mockResolvedValueOnce(MOCK_USER_EXISTING); // fallback after P2002 recovery

    createUserMock.mockRejectedValueOnce(p2002Error());
    linkAccountMock.mockResolvedValue(undefined);
    prismaBizFindUniqueMock.mockResolvedValue({ id: BIZ_ID });

    const result = await provisionTenantForWorkosUser(INPUT);

    expect(result).toBe(BIZ_ID);
    expect(createUserMock).toHaveBeenCalledTimes(1);
    // linkAccount called with the recovered user's id (winner created User but not Account yet).
    expect(linkAccountMock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: MOCK_USER_EXISTING.id }),
    );
    expect(ensurePlaceholderBusinessMock).toHaveBeenCalledWith(MOCK_USER_EXISTING.id);
  });

  // ── Edge: ensurePlaceholderBusiness throws → propagates ───────────────────

  it("throws if ensurePlaceholderBusiness fails", async () => {
    getUserByAccountMock.mockResolvedValue(null);
    getUserByEmailMock.mockResolvedValue(null);
    createUserMock.mockResolvedValue(MOCK_USER_NEW);
    linkAccountMock.mockResolvedValue(undefined);
    ensurePlaceholderBusinessMock.mockRejectedValue(new Error("DB error"));

    await expect(provisionTenantForWorkosUser(INPUT)).rejects.toThrow("DB error");
  });

  // ── Edge: business row missing after successful ensurePlaceholderBusiness ──

  it("throws if business row is missing after provisioning", async () => {
    getUserByAccountMock.mockResolvedValue(null);
    getUserByEmailMock.mockResolvedValue(null);
    createUserMock.mockResolvedValue(MOCK_USER_NEW);
    linkAccountMock.mockResolvedValue(undefined);
    ensurePlaceholderBusinessMock.mockResolvedValue(undefined);
    prismaBizFindUniqueMock.mockResolvedValue(null); // business still missing

    await expect(provisionTenantForWorkosUser(INPUT)).rejects.toThrow(
      /business row missing/,
    );
  });
});
