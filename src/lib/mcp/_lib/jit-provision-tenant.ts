// src/lib/mcp/_lib/jit-provision-tenant.ts
//
// JIT (just-in-time) tenant provisioning for the MCP OAuth 2.1 path.
//
// Pattern: first-OIDC-login provisioning (industry standard). When a WorkOS user
// is verified but has no Velora tenant, we create one on first access instead of
// returning 403. Idempotent — repeated calls with the same sub are safe.
//
// Auth sequence (Auth.js PrismaAdapter, no raw prisma upserts):
//   1. getUserByAccount → already linked? reuse.
//   2. getUserByEmail   → email exists but sub NOT linked → REFUSE (cross-provider
//      auto-merge is an account takeover vector). Auth.js standard: OAuthAccountNotLinked.
//   3. createUser       → brand-new user (both sub AND email are unknown); link account.
//   4. ensurePlaceholderBusiness → canonical Velora Business-creation path.
//
// Cross-provider merge guard (Fix 1):
//   If getUserByEmail returns an existing user but the WorkOS sub is not linked to them,
//   we REFUSE instead of silently linking. A WorkOS user presenting a different sub than
//   the one originally used to create the account must go through an explicit linking flow.
//   This follows Auth.js's refuse-cross-provider-merge standard (OAuthAccountNotLinked).
//   Explicit account-linking for an owner who already has a Google account is a separate
//   future flow — see EmailAlreadyRegisteredError below.
//
// P2002 concurrent-race recovery (Fix 2):
//   createUser / linkAccount can race on a concurrent first-login. On a Prisma P2002
//   unique-constraint violation, we recover by re-fetching the winner's user (via
//   getUserByAccount) and continuing to ensurePlaceholderBusiness. Mirrors the pattern
//   in src/lib/auth-signin-callback.ts. Net: two concurrent first-logins resolve to the
//   same user with no orphan and no spurious 403.
//
// Sources (verified):
//   Auth.js adapter spec: authjs.dev/reference/core/adapters (AdapterUser, linkAccount)
//   Auth.js OAuthAccountNotLinked: authjs.dev/reference/core/errors#oauthaccountnotlinked
//   JIT provisioning pattern: workos.com/docs/user-management/jit-provisioning
//   P2002 recovery mirrors src/lib/auth-signin-callback.ts (L229-L247).

import { PrismaAdapter } from "@auth/prisma-adapter";
import { prisma } from "@/lib/prisma";
import { ensurePlaceholderBusiness } from "@/app/api/onboarding/_lib/business-recovery";
import { cloudLog } from "@/lib/cloud-logger";

// Instantiate the same adapter that auth.ts uses: PrismaAdapter(prisma).
// The shared `prisma` singleton is already the $extends-wrapped client;
// PrismaAdapter accepts `PrismaClient | ReturnType<PrismaClient["$extends"]>`.
const adapter = PrismaAdapter(prisma);

export interface JitProvisionInput {
  sub: string;
  email: string;
  emailVerified: boolean;
}

/**
 * Thrown when the email already belongs to a Velora account created via a
 * different sign-in method (e.g. Google OAuth). The WorkOS sub must be linked
 * explicitly by the owner — auto-merge is refused per Auth.js's
 * OAuthAccountNotLinked standard to prevent cross-provider account takeover.
 *
 * Callers in oauth-verify.ts translate this to 403 ACCOUNT_NEEDS_LINKING.
 */
export class EmailAlreadyRegisteredError extends Error {
  constructor(email: string) {
    super(
      `This email (${email}) already has a Velora account via a different sign-in method. ` +
        "Explicit account linking is required — automatic cross-provider merge is refused.",
    );
    this.name = "EmailAlreadyRegisteredError";
  }
}

/**
 * Provision (or recover) a Velora User + Business for a verified WorkOS user.
 *
 * Returns the businessId that was created or already existed.
 * Throws EmailAlreadyRegisteredError if the email maps to an existing account
 * under a different provider (cross-provider merge refused).
 * Throws on genuine server errors — callers must handle and return a 5xx.
 */
export async function provisionTenantForWorkosUser({
  sub,
  email,
  emailVerified,
}: JitProvisionInput): Promise<string> {
  // ── Step 1: check if this WorkOS sub is already linked ─────────────────────
  let user = await adapter.getUserByAccount!({
    provider: "workos",
    providerAccountId: sub,
  });

  let accountLinked = user !== null;

  // ── Step 2: account not linked yet — check for email collision ────────────
  if (!user) {
    const byEmail = await adapter.getUserByEmail!(email);
    if (byEmail) {
      // SECURITY: an existing User row was found for this email, but the incoming
      // WorkOS sub is NOT linked to it. Silently linking would hand one identity's
      // account to a different credential — a classic cross-provider takeover.
      // Auth.js standard is to REFUSE and surface OAuthAccountNotLinked.
      // The owner must explicitly link their accounts via a dedicated flow.
      cloudLog({
        severity: "WARNING",
        component: "System",
        action: "JIT_CROSS_PROVIDER_REFUSED",
        a2a_transfer: false,
        message: "JIT: refused cross-provider auto-merge — email already registered via different method",
        businessId: "",
        data: { email, existingUserId: byEmail.id },
      });
      throw new EmailAlreadyRegisteredError(email);
    }

    // Brand-new user — both sub AND email are unknown. Create via adapter then
    // link, with P2002 race recovery (Fix 2).
    try {
      user = await adapter.createUser!({
        id: "",          // stripped by PrismaAdapter before insert
        email,
        emailVerified: emailVerified ? new Date() : null,
        name: null,
        image: null,
      });

      cloudLog({
        severity: "INFO",
        component: "System",
        action: "JIT_USER_CREATED",
        a2a_transfer: false,
        message: "JIT: created new Velora User for WorkOS sub",
        businessId: "",
        data: { userId: user.id, email },
      });
    } catch (err) {
      // P2002 on User.email → a concurrent first-login already created the row.
      // Recover by re-fetching the winner; continue to ensurePlaceholderBusiness.
      const errCode =
        err && typeof err === "object" && "code" in err
          ? (err as { code?: unknown }).code
          : undefined;
      if (errCode === "P2002") {
        const winner = await adapter.getUserByAccount!({
          provider: "workos",
          providerAccountId: sub,
        });
        if (winner) {
          // The concurrent winner also ran linkAccount — fully provisioned already.
          accountLinked = true;
          user = winner;
        } else {
          // User row created concurrently but linkAccount not yet done. Re-fetch by email.
          const byEmailAfterRace = await adapter.getUserByEmail!(email);
          if (!byEmailAfterRace) {
            throw new Error(
              "JIT provisioning: P2002 on createUser but getUserByEmail returned null — unexpected state",
            );
          }
          user = byEmailAfterRace;
        }
      } else {
        throw err;
      }
    }
  }

  // ── Step 3: link the WorkOS Account if not already linked ──────────────────
  if (!accountLinked) {
    try {
      await adapter.linkAccount!({
        userId: user.id,
        type: "oauth",
        provider: "workos",
        providerAccountId: sub,
      });
    } catch (err) {
      // P2002 on Account[provider, providerAccountId] → concurrent linkAccount won.
      // The account is now linked — treat as success.
      const errCode =
        err && typeof err === "object" && "code" in err
          ? (err as { code?: unknown }).code
          : undefined;
      if (errCode !== "P2002") throw err;
      // Re-fetch the user the winner linked to (sub is now authoritative).
      const winner = await adapter.getUserByAccount!({
        provider: "workos",
        providerAccountId: sub,
      });
      if (winner) user = winner;
    }
  }

  // ── Step 4: ensure the Business placeholder exists ─────────────────────────
  // ensurePlaceholderBusiness is the canonical Velora Business-creation path
  // (delegates to initializeBusinessOnboardingState). Idempotent via upsert.
  await ensurePlaceholderBusiness(user.id);

  // ── Step 5: resolve and return businessId ──────────────────────────────────
  const biz = await prisma.business.findUnique({
    where: { userId: user.id },
    select: { id: true },
  });

  if (!biz?.id) {
    // ensurePlaceholderBusiness succeeded without throwing but the row is still
    // missing — should not happen, but defend explicitly.
    throw new Error(
      `JIT provisioning: business row missing after ensurePlaceholderBusiness for userId=${user.id}`,
    );
  }

  cloudLog({
    severity: "INFO",
    component: "System",
    action: "JIT_TENANT_PROVISIONED",
    a2a_transfer: false,
    message: "JIT: Velora tenant ready for WorkOS user",
    businessId: biz.id,
    data: { userId: user.id, email, accountLinked },
  });

  return biz.id;
}
