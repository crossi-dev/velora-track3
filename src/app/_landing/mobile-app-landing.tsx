"use client";

import { useSearchParams } from "next/navigation";
import "../landing-mobile-app.css";
import { RolePicker } from "./role-picker";
import type { LandingDict } from "./i18n";

const AUTH_ERROR_MESSAGES: Record<string, string> = {
  OAuthAccountNotLinked: "Algo salió mal con el login. Probá de nuevo.",
  OAuthCallbackError: "La sesión expiró. Tocá de nuevo el botón.",
  Callback: "La sesión expiró. Tocá de nuevo el botón.",
  AccessDenied: "Acceso denegado. Verificá los permisos en Google.",
};

function VeloraMarkLarge() {
  return (
    <svg width="40" height="40" viewBox="0 0 64 64" fill="none" aria-hidden="true">
      <path
        d="M20 44V20M20 44L44 20M44 20V34"
        stroke="currentColor"
        strokeWidth="7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function MobileAppLanding({
  dict,
  locale = "es-AR",
  onSignIn,
  isSigningIn,
  nativeError,
  onDismissError,
}: {
  dict: LandingDict;
  locale?: import("./i18n").Locale;
  onSignIn: () => void;
  isSigningIn: boolean;
  nativeError: string | null;
  onDismissError: () => void;
}) {
  const searchParams = useSearchParams();
  const authError = searchParams.get("error");
  const authErrorMessage = authError
    ? (AUTH_ERROR_MESSAGES[authError] ?? "No pudimos iniciarte sesión. Tocá de nuevo.")
    : null;
  const sessionExpiredMessage = searchParams.get("session_expired") === "1"
    ? "Tu sesión expiró. Volvé a iniciar sesión para continuar."
    : null;
  const displayError = authErrorMessage ?? sessionExpiredMessage ?? nativeError;

  return (
    <div className="lp-app" lang={locale}>
      <header className="lp-app-brand">
        <div className="lp-app-mark" aria-hidden="true">
          <VeloraMarkLarge />
        </div>
        <h1 className="lp-app-wordmark">Velora</h1>
        <p className="lp-app-tagline">{dict.hero.tagline}</p>
      </header>

      <section className="lp-app-headline">
        <h2>
          {dict.hero.headline} <em>{dict.hero.headlineEm}.</em>
        </h2>
        <p>{dict.hero.lede}</p>
      </section>

      {displayError && (
        <div className="lp-app-error" role="alert">
          <span>{displayError}</span>
          <button
            type="button"
            onClick={onDismissError}
            aria-label="Cerrar"
          >
            ×
          </button>
        </div>
      )}

      <div className="lp-app-actions">
        <RolePicker
          onSignIn={onSignIn}
          isSigningIn={isSigningIn}
          dict={dict}
        />
      </div>

      <p className="lp-app-trust">
        🔒 Tus datos no se guardan
        <span className="lp-app-trust-dot">·</span>
        Datos privados
      </p>
    </div>
  );
}
