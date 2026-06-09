import type { NextAuthConfig } from "next-auth";
import Google from "next-auth/providers/google";

export const authConfig = {
  // trustHost: true es necesario para el path de Capacitor (Android WebView).
  // El WebView envía requests con el host header del dominio Cloud Run / somosvelora,
  // y el callback de OAuth necesita resolverse correctamente. No es vulnerabilidad en
  // este setup porque el deploy vive en Cloud Run (host header controlado por GCP)
  // y el WebView siempre carga desde la URL conocida.
  trustHost: true,
  // Recovery routing: si NextAuth falla, redirigimos a páginas propias.
  // - signIn: "/" (la landing ES la página de sign-in)
  // - error: "/auth/error" muestra mensajes en español según el código de error
  //   (AccessDenied → instrucciones + link a soporte; otros → genérico).
  //   Anteriormente era "/" pero eso ocultaba el error_code en la URL y dejaba
  //   al usuario sin contexto ni camino de recuperación.
  pages: {
    signIn: "/",
    error: "/auth/error",
  },
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID ?? "",
      clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
      // OAuth 2.1 / OpenID Connect 2026 hardening:
      //  - pkce: ya viene por default (S256). Defensa contra code-injection.
      //  - state: CSRF binding del request al callback. Defensa en profundidad
      //    aunque PKCE solo ya es spec-compliant en OAuth 2.1.
      //  - nonce: obligatorio en OIDC 2026 para vincular el ID token a este
      //    request específico — sin nonce, un ID token filtrado podría
      //    replayarse en otra sesión.
      checks: ["pkce", "state", "nonce"],
      // allowDangerousEmailAccountLinking was removed 2026-05-19 (security fix).
      // The flag bypasses NextAuth's OAuthAccountNotLinked guard, allowing an
      // attacker with a Google account sharing the same email to take over an
      // existing owner account. The signIn callback in auth.ts already handles
      // the only legitimate cross-device scenario (partial DB wipe → no Account
      // row) by explicitly checking the DB and rejecting providerAccountId
      // mismatches. That is sufficient protection; this flag is unnecessary.
    }),
    // NOTE: The google-native Credentials provider for Capacitor Android has been
    // moved to src/auth.ts (Node.js runtime). auth.config.ts is imported by
    // middleware (Edge Runtime) and Credentials providers are not Edge-compatible —
    // their presence caused req.auth to silently return null for every OAuth cookie
    // request, breaking desktop login. The Credentials provider is safe in auth.ts
    // because that module only runs in Node.js route handlers.
  ],
  session: {
    strategy: "jwt",
    // 7 días para mobile (el usuario no debería re-loguearse cada día).
    // Default de NextAuth es 30 días — demasiado para una app con datos financieros.
    maxAge: 7 * 24 * 60 * 60,
  },
  callbacks: {
    jwt({ token, user }) {
      // Base token hydration — runs in Edge (middleware) and Node.
      // sessionVersion is injected by the full jwt callback in auth.ts (Node only).
      // Here we preserve it across token refreshes so it's never stripped.
      token.id = (token.id as string | undefined) ?? user?.id ?? token.sub;
      return token;
    },
    session({ session, token }) {
      session.user.id = (token.id ?? token.sub) as string;
      return session;
    },
  },
} satisfies NextAuthConfig;
