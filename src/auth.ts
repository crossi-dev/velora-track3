import NextAuth from "next-auth";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { prisma } from "@/lib/prisma";
import { cloudLog } from "@/lib/cloud-logger";
import { authConfig } from "@/auth.config";
import {
  getUserSessionVersion,
  invalidateUserSession as _invalidateUserSession,
} from "@/lib/auth-session-version";
import { handleSignIn } from "@/lib/auth-signin-callback";

/**
 * Ensures a Business placeholder exists for the given userId.
 * Called from the createUser event (OAuth) and the native-session route.
 * The @@unique userId relation makes repeated calls idempotent.
 */
export async function ensureBusinessPlaceholder(userId: string): Promise<void> {
  try {
    const existing = await prisma.business.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (existing) return;
    await prisma.business.create({
      data: { userId, name: "", type: "", taxRate: 0 },
      select: { id: true },
    });
  } catch (err) {
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "BUSINESS_PLACEHOLDER_CREATE_FAILED",
      a2a_transfer: false,
      message: "Failed to create placeholder Business",
      businessId: "",
      data: { userId, error: err instanceof Error ? err.message : String(err) },
    });
  }
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  adapter: PrismaAdapter(prisma),
  providers: [
    // m3: the google-native Credentials provider was removed — it was dead code.
    // The Capacitor native path posts directly to /api/auth/native-session which
    // issues a Velora HMAC token; signIn("google-native") is never called.
    ...authConfig.providers,
  ],
  callbacks: {
    ...authConfig.callbacks,

    /**
     * JWT callback — Node.js runtime only (auth.ts, not auth.config.ts).
     *
     * On fresh sign-in (user present): reads sessionVersion from DB and embeds
     * it in the token so future requests can validate it without a full session
     * lookup — just a lightweight version comparison.
     *
     * On token refresh / existing JWT (no user): compares token.sessionVersion
     * against DB.sessionVersion (via 60 s in-memory cache). Mismatch or missing
     * user returns null → NextAuth clears the cookie → browser redirects to login.
     */
    async jwt({ token, user }) {
      // Preserve token.id on every pass (base config behaviour).
      token.id = (token.id as string | undefined) ?? user?.id ?? token.sub;

      if (user) {
        // Fresh sign-in — embed current sessionVersion.
        const userId = user.id ?? token.sub;
        if (userId) {
          const version = await getUserSessionVersion(userId);
          token.sessionVersion = version ?? 1;
        }
      } else if (token.sub) {
        // Existing JWT — validate sessionVersion against DB (cached).
        const dbVersion = await getUserSessionVersion(token.sub);

        if (dbVersion === null) {
          // User was deleted — clear the session. This is expected after a DB wipe
          // or manual user removal; downgraded to DEBUG because it is not actionable
          // and was generating noise (59 hits/24 h from a single stale cookie).
          // getUserSessionVersion() caches the absence for 60 s, so this branch
          // is reached at most once per minute per deleted userId.
          cloudLog({
            severity: "DEBUG",
            component: "System",
            action: "AUTH_SESSION_USER_DELETED",
            a2a_transfer: false,
            message: "JWT validation: user not found in DB — clearing session cookie",
            businessId: "",
            data: { userId: token.sub },
          });
          return null;
        }

        const tokenVersion = (token.sessionVersion as number | undefined) ?? 1;
        if (dbVersion !== tokenVersion) {
          // sessionVersion was incremented — token is invalidated.
          cloudLog({
            severity: "INFO",
            component: "System",
            action: "AUTH_SESSION_INVALIDATED",
            a2a_transfer: false,
            message: "JWT rejected: sessionVersion mismatch — forcing logout",
            businessId: "",
            data: { userId: token.sub, tokenVersion, dbVersion },
          });
          return null;
        }
      }

      return token;
    },

    // signIn logic lives in src/lib/auth-signin-callback.ts to stay under 300 lines.
    // See that file for the full timing contract and partial-DB-wipe recovery notes.
    signIn: handleSignIn,
  },
  events: {
    // Cuando un dueño se loguea por primera vez con Google OAuth (desktop),
    // el PrismaAdapter crea la fila User. Aprovechamos este evento para crear
    // una fila Business placeholder — los campos los rellena el flujo
    // conversacional. La relación userId es @unique (1:1), así que
    // ensureBusinessPlaceholder es idempotente y no afecta usuarios existentes.
    // Vive en auth.ts (no auth.config.ts) porque la config se importa también
    // desde middleware.ts (Edge Runtime), donde Prisma no está disponible.
    async createUser({ user }) {
      if (user.id) await ensureBusinessPlaceholder(user.id);
    },
  },
});
