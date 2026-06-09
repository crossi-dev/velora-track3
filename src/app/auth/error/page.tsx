"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";

function AuthErrorContent() {
  const params = useSearchParams();
  const error = params.get("error");

  const isAccessDenied = error === "AccessDenied";

  return (
    <main
      data-theme="light"
      style={{
        // Velora brand: cream + navy + Fraunces. Same palette as landing.
        // colorScheme: "light only" blocks OS dark mode UA styling from
        // bleeding into form controls / scrollbars in this subtree.
        colorScheme: "light only",
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "2rem",
        backgroundColor: "#FAF6EE",
        color: "#1B3A6B",
        fontFamily: "ui-sans-serif, system-ui, -apple-system, sans-serif",
      }}
    >
      <div
        style={{
          maxWidth: "32rem",
          width: "100%",
          textAlign: "center",
        }}
      >
        <h1
          style={{
            fontFamily:
              "var(--font-fraunces), ui-serif, Georgia, serif",
            fontSize: "clamp(1.75rem, 5vw, 2.5rem)",
            fontWeight: 600,
            letterSpacing: "-0.015em",
            lineHeight: 1.15,
            marginBottom: "1rem",
            color: "#1B3A6B",
          }}
        >
          {isAccessDenied ? "Acceso no autorizado" : "Error al iniciar sesión"}
        </h1>

        <p
          style={{
            fontSize: "1rem",
            lineHeight: 1.6,
            color: "rgba(27, 58, 107, 0.80)",
            marginBottom: "1.5rem",
          }}
        >
          {isAccessDenied
            ? "Tu cuenta de Google no tiene acceso a Velora. Si sos el dueño y acabás de configurar la cuenta, puede que haya ocurrido un problema de sincronización con la base de datos."
            : "Ocurrió un error durante el proceso de autenticación. Por favor intentá nuevamente."}
        </p>

        {isAccessDenied && (
          <p
            style={{
              fontSize: "0.875rem",
              lineHeight: 1.5,
              color: "rgba(27, 58, 107, 0.60)",
              marginBottom: "2rem",
            }}
          >
            Si el problema persiste, contactá a soporte para que podamos
            restaurar tu acceso manualmente.
          </p>
        )}

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "1rem",
            alignItems: "center",
            marginTop: "0.5rem",
          }}
        >
          <a
            href="/"
            style={{
              display: "inline-block",
              padding: "0.875rem 2.25rem",
              backgroundColor: "#1B3A6B",
              color: "#FAF6EE",
              borderRadius: "999px",
              fontSize: "1rem",
              fontWeight: 600,
              lineHeight: 1.5,
              textDecoration: "none",
              boxShadow:
                "0 1px 0 rgba(27,58,107,.10), 0 10px 24px -12px rgba(27,58,107,.4)",
            }}
          >
            Volver al inicio
          </a>

          {isAccessDenied && (
            <a
              href="mailto:contact@example.com?subject=Velora%20%E2%80%94%20Problema%20de%20acceso&body=Hola%2C%20no%20puedo%20acceder%20a%20mi%20cuenta%20de%20Velora.%20Mi%20email%20de%20Google%20es%3A%20"
              style={{
                fontSize: "0.875rem",
                color: "#1B3A6B",
                textDecoration: "underline",
                lineHeight: 1.5,
              }}
            >
              Contactar soporte
            </a>
          )}
        </div>
      </div>
    </main>
  );
}

export default function AuthErrorPage() {
  return (
    <Suspense>
      <AuthErrorContent />
    </Suspense>
  );
}
