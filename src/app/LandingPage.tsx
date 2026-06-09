"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { signIn } from "next-auth/react";
import LandingTemplate, { getCopy } from "@/components/landing/LandingPage";
import type { Locale } from "./_landing/i18n";
import { getDict } from "./_landing/i18n";
import { isCapacitor } from "@/lib/capacitor-helpers";
import { installNativeFetchInterceptor, storeNativeToken } from "@/lib/native-fetch-interceptor";
import { MobileAppLanding } from "./_landing/mobile-app-landing";

/**
 * Sign-in entrypoint — desktop vs native Android.
 *
 * Desktop path: standard NextAuth Google OAuth (PKCE, redirect flow).
 *
 * Native path (Capacitor Android): the Google Sign-In SDK runs inside the
 * WebView process and returns a signed idToken directly — no Chrome Custom
 * Tabs involved, no PKCE cookie mismatch. The idToken is posted to
 * /api/auth/native-session which verifies it server-side with google-auth-library
 * and issues a Velora HMAC token stored in @capacitor/preferences (Keystore).
 */
// Build cache buster 2026-05-13: force Turbopack to recompile this file —
// the previous deploy kept the pre-fix bundle (window.location.href) cached.
async function handleSignIn(
  navigate: (path: string) => void,
  onError: (msg: string) => void,
) {
  if (isCapacitor()) {
    try {
      // Dynamic import keeps the native plugin out of the desktop bundle.
      const { GoogleAuth } = await import(
        "@codetrix-studio/capacitor-google-auth"
      );
      await GoogleAuth.initialize();
      const user = await GoogleAuth.signIn();
      const idToken = user.authentication.idToken;
      if (!idToken) {
        console.error("[handleSignIn] native sign-in returned no idToken");
        return;
      }
      // Cookie-free path: POST the idToken directly to our endpoint which
      // verifies it server-side and returns a signed HMAC token. The token
      // is stored in Preferences (Android Keystore) and injected on all
      // subsequent requests via the fetch interceptor — no WebView cookie.
      const res = await fetch("/api/auth/native-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken }),
        credentials: "omit",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { message?: string }
          | null;
        const msg = body?.message ?? `HTTP ${res.status}`;
        onError(`Login error: ${msg}`);
        throw new Error(msg);
      }
      const { token } = (await res.json()) as { token: string };
      // C1: store in Preferences (Android Keystore) instead of localStorage.
      await storeNativeToken(token);
      // Install the fetch interceptor so all subsequent requests carry the token.
      installNativeFetchInterceptor();
      // Client-side navigation — required because full-page nav (window.location)
      // does NOT carry the x-velora-owner-token header. router.push triggers
      // a fetch of the RSC payload, which IS patched by the interceptor and
      // carries the token, so middleware sees a valid native session.
      navigate("/dashboard");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[handleSignIn] native Google Sign-In failed:", err);
      onError(`Login error: ${msg}`);
      throw err;
    }
    return;
  }
  void signIn("google", { callbackUrl: "/dashboard" });
}

const AUTH_ERROR_MESSAGES: Record<string, string> = {
  OAuthAccountNotLinked: "Algo salió mal con el login. Probá de nuevo.",
  OAuthCallbackError: "La sesión expiró. Tocá de nuevo el botón.",
  Callback: "La sesión expiró. Tocá de nuevo el botón.",
  AccessDenied: "Acceso denegado. Verificá los permisos en Google.",
};

export default function LandingPage({ locale = "es-AR" }: { locale?: Locale }) {
  const dict = getDict(locale);
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [nativeError, setNativeError] = useState<string | null>(null);
  // Tracks manual dismissal of URL-param errors (authError / sessionExpired).
  // nativeError is cleared directly via setNativeError(null), but URL-param
  // errors can't be cleared without a router replace — dismissal is tracked here.
  const [errorDismissed, setErrorDismissed] = useState(false);
  // SSR + first client render → false (web). useEffect flips to true only
  // inside the Capacitor WebView, swapping in the dedicated mobile-app
  // landing. Web visitors never see the swap; APK users see one cheap
  // re-render after mount, hidden by the Capacitor splash.
  const [isMobileApp, setIsMobileApp] = useState(false);

  const authError = searchParams.get("error");
  const authErrorMessage = authError
    ? (AUTH_ERROR_MESSAGES[authError] ?? "No pudimos iniciarte sesión. Tocá de nuevo.")
    : null;

  const sessionExpired = searchParams.get("session_expired") === "1";
  const sessionExpiredMessage = sessionExpired
    ? "Tu sesión expiró. Volvé a iniciar sesión para continuar."
    : null;

  const rawError = authErrorMessage ?? sessionExpiredMessage ?? nativeError;
  const displayError = errorDismissed ? null : rawError;

  // BFCache recovery: when the user starts the Google OAuth flow and then
  // bounces back (cancel, browser back, restored tab), the browser may
  // restore this page from the BFCache with isSigningIn=true frozen, leaving
  // the button permanently disabled showing "Conectando…". Reset on
  // pageshow when persisted=true, which fires only on a BFCache restore.
  useEffect(() => {
    const onPageShow = (e: PageTransitionEvent) => {
      if (e.persisted) setIsSigningIn(false);
    };
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, []);

  useEffect(() => {
    setIsMobileApp(isCapacitor());
  }, []);

  const onSignIn = () => {
    if (isSigningIn) return;
    setIsSigningIn(true);
    setNativeError(null);
    setErrorDismissed(false);
    // Safety net: if signIn() hasn't navigated within 8s the flow is broken
    // (popup blocked, network stalled, plugin error). Reset so the button
    // becomes clickable again instead of looking dead.
    const safety = window.setTimeout(() => setIsSigningIn(false), 8000);
    handleSignIn(
      (path) => router.push(path),
      (msg) => setNativeError(msg),
    ).catch(() => {
      window.clearTimeout(safety);
      setIsSigningIn(false);
    });
  };

  if (isMobileApp) {
    return (
      <MobileAppLanding
        dict={dict}
        locale={locale}
        onSignIn={onSignIn}
        isSigningIn={isSigningIn}
        nativeError={nativeError}
        onDismissError={() => setNativeError(null)}
      />
    );
  }

  // Theme isolation is handled by the (landing) route group layout
  // (src/app/(landing)/layout.tsx) via `color-scheme: light only`. No inline
  // style overrides needed here.
  return (
    <div lang={locale}>
      {displayError && (
        <div
          role="alert"
          style={{
            background: "rgba(217, 48, 37, 0.08)",
            color: "#B3261E",
            border: "1px solid rgba(217, 48, 37, 0.25)",
            borderRadius: "12px",
            padding: "12px 16px",
            fontFamily: "ui-sans-serif, system-ui, sans-serif",
            fontSize: "0.875rem",
            lineHeight: 1.5,
            margin: "12px 16px 0",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: "12px",
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            zIndex: 60,
          }}
        >
          <span>{displayError}</span>
          <button
            type="button"
            onClick={() => { setNativeError(null); setErrorDismissed(true); }}
            aria-label="Cerrar"
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              color: "#B3261E",
              fontSize: "1rem",
              lineHeight: 1,
              padding: 0,
              flexShrink: 0,
              minWidth: "44px",
              minHeight: "44px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            ×
          </button>
        </div>
      )}
      <LandingTemplate onSignIn={onSignIn} copy={getCopy(locale)} locale={locale} />
    </div>
  );
}
