/**
 * signIn callback for NextAuth — extracted to keep auth.ts under the 300-line limit.
 *
 * TIMING CONTRACT (@auth/core v5 beta.31):
 *   signIn fires inside handleAuthorized, which is called BEFORE handleLoginOrRegister.
 *   At this point NO User or Account rows have been created yet for a new sign-up.
 *   @auth/core synthesises user.id via crypto.randomUUID() (see getUserAndAccount in
 *   oauth/callback.js) — so user.id is always a UUID, but it will NOT exist in our DB
 *   for a brand-new user. We detect this by doing a DB lookup: no User row → new
 *   sign-up → return true so the PrismaAdapter can create rows via handleLoginOrRegister.
 *
 * PARTIAL-DB-WIPE RECOVERY PATH:
 *   If getUserByAccount returned a real DB row (so user.id is a real UUID that exists
 *   in the DB), but no Account row exists for it, auto-relink the Account so the owner
 *   can log back in without ops intervention. Identity is confirmed by Google OAuth.
 *   Manual procedure if auto-relink is ever disabled:
 *     INSERT into Account (userId, provider='google', providerAccountId, type='oauth').
 */

import type { Account, Profile, User } from "next-auth";
import type { AdapterUser } from "next-auth/adapters";
import { prisma } from "@/lib/prisma";
import { cloudLog } from "@/lib/cloud-logger";

export async function handleSignIn({
  user,
  account,
  profile,
}: {
  user: User | AdapterUser;
  account?: Account | null;
  profile?: Profile;
}): Promise<boolean> {
  cloudLog({
    severity: "INFO",
    component: "System",
    action: "AUTH_SIGNIN_START",
    a2a_transfer: false,
    message: "signIn callback invoked",
    businessId: "",
    data: {
      provider: account?.provider ?? null,
      userId: user?.id ?? null,
      email: user?.email ?? null,
      providerAccountId: account?.providerAccountId ?? null,
    },
  });

  if (!account) {
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "AUTH_SIGNIN_TRACE",
      a2a_transfer: false,
      message: "signIn rejected: no account object",
      businessId: "",
      data: { path: "rejected_no_account", userId: user?.id ?? null, email: user?.email ?? null, provider: null },
    });
    return false;
  }

  if (account.provider !== "google") {
    if (profile?.email_verified !== true) {
      cloudLog({
        severity: "WARNING",
        component: "System",
        action: "AUTH_SIGNIN_TRACE",
        a2a_transfer: false,
        message: "Sign-in rejected: non-Google provider did not supply a verified email",
        businessId: "",
        data: { path: "rejected_non_google_unverified", provider: account.provider, userId: user.id ?? "unknown" },
      });
      return false;
    }
    cloudLog({
      severity: "INFO",
      component: "System",
      action: "AUTH_SIGNIN_TRACE",
      a2a_transfer: false,
      message: "signIn allowed: non-Google provider with verified email",
      businessId: "",
      data: { path: "allowed_non_google_verified", provider: account.provider, userId: user?.id ?? null },
    });
    return true;
  }

  // Guard: user.id is typed string | undefined. @auth/core always sets a UUID
  // for Google OAuth before signIn fires, but the type doesn't enforce it.
  // An undefined id would cause prisma.findUnique({ where: { id: undefined } })
  // to omit the filter entirely — reject early instead of risking a bad query.
  if (!user.id) {
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "AUTH_SIGNIN_TRACE",
      a2a_transfer: false,
      message: "signIn rejected: user.id is undefined — unexpected @auth/core state",
      businessId: "",
      data: { path: "rejected_no_user_id", email: user?.email ?? null, provider: account.provider },
    });
    return false;
  }

  // Fast path: check Account first. Normal returning users have an Account row,
  // so we avoid the extra User.findUnique round-trip on every sign-in.
  const existingAccount = await prisma.account.findFirst({
    where: { userId: user.id, provider: "google" },
    select: { id: true, providerAccountId: true },
  });

  if (existingAccount) {
    // Account found — normal returning user. Skip the User.findUnique check.
    if (existingAccount.providerAccountId !== account.providerAccountId) {
      cloudLog({
        severity: "WARNING",
        component: "System",
        action: "AUTH_SIGNIN_TRACE",
        a2a_transfer: false,
        message: "signIn rejected: Google providerAccountId mismatch — possible account takeover attempt",
        businessId: "",
        data: { path: "rejected_provider_id_mismatch", userId: user.id, email: user?.email ?? null, provider: account.provider, stored: existingAccount.providerAccountId, incoming: account.providerAccountId },
      });
      return false;
    }

    cloudLog({
      severity: "INFO",
      component: "System",
      action: "AUTH_SIGNIN_TRACE",
      a2a_transfer: false,
      message: "signIn allowed: existing Google account matched",
      businessId: "",
      data: { path: "existing_account_match", userId: user.id, email: user?.email ?? null, provider: account.provider },
    });
    return true;
  }

  // No Account row found by `user.id`. AUD-1 (2026-05-28) discovered that
  // `user.id` is ALWAYS a transient `crypto.randomUUID()` generated by
  // `@auth/core` in `oauth/callback.js:getUserAndAccount()` — it is NEVER the
  // user's real DB cuid. The original code did `prisma.user.findUnique({ id })`
  // here, which always returned null, even when the User row existed under a
  // different provider (`google-native` from Capacitor login). That caused
  // `OAuthAccountNotLinked` errors when a native-signed user tried to log in
  // via desktop OAuth: the callback said "new user, handing off to adapter",
  // then @auth/core's `handleLoginOrRegister` did its own `getUserByEmail`,
  // found the real User row, and threw `OAuthAccountNotLinked` because no
  // `google` provider Account linked it.
  //
  // Fix: look up the User by EMAIL (the only stable identifier @auth/core gives
  // us before the adapter has run). If found, this is a cross-provider relink
  // case (or a partial-DB-wipe with the User row surviving). Auto-create the
  // Account row pointing at the REAL user.id from the DB, not user.id from
  // @auth/core. If not found, hand off to the adapter as a genuine new sign-up.
  if (!user?.email) {
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "AUTH_SIGNIN_TRACE",
      a2a_transfer: false,
      message: "signIn rejected: no email on OAuth profile — cannot safely relink",
      businessId: "",
      data: { path: "rejected_no_email", provider: account.provider },
    });
    return false;
  }

  const existingUser = await prisma.user.findUnique({
    where: { email: user.email },
    select: { id: true },
  });

  if (!existingUser) {
    cloudLog({
      severity: "INFO",
      component: "System",
      action: "AUTH_SIGNIN_TRACE",
      a2a_transfer: false,
      message: "signIn allowed: new Google OAuth sign-up — no DB row yet, handing off to adapter",
      businessId: "",
      data: { path: "fresh_new_user_no_db_row", userId: user?.id ?? null, email: user.email, provider: account.provider, providerAccountId: account.providerAccountId },
    });
    return true;
  }

  // User row exists but no Account row for the google provider →
  // (a) partial DB wipe recovery (only Account rows were dropped), OR
  // (b) cross-provider relink (User row was created by Capacitor native login
  //     with provider="google-native", now signing in via desktop OAuth which
  //     uses provider="google").
  // Wrap in $transaction so the find + create is atomic and cannot produce
  // a race where two concurrent sign-ins both see no Account and both try to create.
  const realUserId = existingUser.id; // canonical DB cuid (NOT user.id from @auth/core)
  {
    try {
      await prisma.$transaction(async (tx) => {
        // Re-check inside the transaction to handle concurrent relinks.
        const accountInTx = await tx.account.findFirst({
          where: { userId: realUserId, provider: "google" },
          select: { id: true },
        });
        if (accountInTx) return; // Concurrent relink already done — nothing to do.

        await tx.account.create({
          data: {
            userId: realUserId,
            type: "oauth",
            provider: "google",
            providerAccountId: account.providerAccountId,
            access_token: account.access_token ?? null,
            refresh_token: account.refresh_token ?? null,
            expires_at: account.expires_at ?? null,
            token_type: account.token_type ?? null,
            scope: account.scope ?? null,
            id_token: account.id_token ?? null,
          },
        });
      });
      cloudLog({
        severity: "INFO",
        component: "System",
        action: "AUTH_SIGNIN_TRACE",
        a2a_transfer: false,
        message: "signIn allowed: Account row auto-created for pre-existing User (cross-provider relink or partial DB wipe recovery)",
        businessId: "",
        data: { path: "auto_relinked", userId: realUserId, email: user.email, provider: account.provider, providerAccountId: account.providerAccountId },
      });
      return true;
    } catch (err) {
      // P2002 means a concurrent relink already created the Account row — that's a
      // success, not a failure. Returning false here would lock the owner out even
      // though the Account row now exists. Any other error is a real failure.
      const errCode = err && typeof err === "object" && "code" in err
        ? (err as { code?: unknown }).code
        : undefined;
      if (errCode === "P2002") {
        cloudLog({
          severity: "INFO",
          component: "System",
          action: "AUTH_SIGNIN_TRACE",
          a2a_transfer: false,
          message: "signIn allowed: concurrent relink already created Account row (P2002) — treated as success",
          businessId: "",
          data: { path: "auto_relinked_concurrent", userId: realUserId, email: user.email, provider: account.provider },
        });
        return true;
      }
      cloudLog({
        severity: "WARNING",
        component: "System",
        action: "AUTH_SIGNIN_TRACE",
        a2a_transfer: false,
        message: "signIn rejected: failed to auto-relink Account row for cross-provider / partial DB wipe recovery",
        businessId: "",
        data: { path: "rejected_relink_failed", userId: realUserId, email: user.email, provider: account.provider, error: err instanceof Error ? err.message : String(err) },
      });
      return false;
    }
  }
}
