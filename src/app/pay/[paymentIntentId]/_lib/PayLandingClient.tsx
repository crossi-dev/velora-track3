"use client";

import { useEffect, useState } from "react";

interface Props {
  checkoutUrl: string;
  montoFormatted: string;
  customerName: string | null;
}

export function PayLandingClient({ checkoutUrl, montoFormatted, customerName }: Props) {
  const [countdown, setCountdown] = useState(3);

  // JS redirect after 3 s — mirrors the <meta http-equiv="refresh"> fallback
  // in the server component. We rely on JS for the countdown display only;
  // the actual redirect works even without JS via the meta tag.
  useEffect(() => {
    const interval = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          clearInterval(interval);
          window.location.href = checkoutUrl;
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [checkoutUrl]);

  const greeting = customerName ? `Hola ${customerName},` : "Hola,";

  return (
    <div
      style={{
        minHeight: "100dvh",
        background: "linear-gradient(135deg, #1B3A6B 0%, #0F2347 60%, #0a1a35 100%)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "2rem 1.25rem",
        fontFamily:
          "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      }}
    >
      {/* Card */}
      <div
        style={{
          background: "rgba(255,255,255,0.05)",
          border: "1px solid rgba(255,255,255,0.12)",
          borderRadius: "1.5rem",
          padding: "2.5rem 2rem",
          maxWidth: "420px",
          width: "100%",
          textAlign: "center",
          backdropFilter: "blur(12px)",
        }}
      >
        {/* Logo mark */}
        <div
          style={{
            width: "3rem",
            height: "3rem",
            borderRadius: "50%",
            background: "radial-gradient(circle at 30% 30%, #4A7FBF, #1B3A6B 70%)",
            boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.25), 0 4px 20px rgba(74,127,191,0.4)",
            margin: "0 auto 1.25rem",
          }}
        />

        {/* Wordmark — opacity raised to 0.87 to meet WCAG 1.4.3 AA 4.5:1 on darkest gradient point */}
        <p
          style={{
            color: "rgba(255,255,255,0.87)",
            fontSize: "0.875rem",
            letterSpacing: "0.12em",
            textTransform: "uppercase",
            margin: "0 0 2rem",
          }}
        >
          Velora
        </p>

        {/* Greeting */}
        <p
          style={{
            color: "rgba(255,255,255,0.75)",
            fontSize: "1.125rem",
            margin: "0 0 0.5rem",
          }}
        >
          {greeting}
        </p>

        {/* Amount */}
        <p
          style={{
            color: "#fff",
            fontSize: "clamp(2.5rem, 8vw, 3.5rem)",
            fontWeight: 700,
            letterSpacing: "-0.03em",
            lineHeight: 1.1,
            margin: "0 0 0.75rem",
          }}
        >
          {montoFormatted}
        </p>

        <p
          style={{
            color: "rgba(255,255,255,0.75)",
            fontSize: "1rem",
            margin: "0 0 2.5rem",
          }}
        >
          tu link de pago está listo.
        </p>

        {/* CTA — min-height 52px satisfies WCAG 2.5.5 touch target (44px min) */}
        <a
          href={checkoutUrl}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            minHeight: "52px",
            background: "linear-gradient(135deg, #009ee3 0%, #0070cc 100%)",
            color: "#fff",
            fontSize: "1.125rem",
            fontWeight: 600,
            textDecoration: "none",
            borderRadius: "0.875rem",
            padding: "1rem 1.5rem",
            boxShadow: "0 4px 24px rgba(0,158,227,0.35)",
            transition: "transform 0.15s ease, box-shadow 0.15s ease",
            marginBottom: "1.25rem",
          }}
        >
          Continuar al pago seguro de Mercado Pago →
        </a>

        {/* Countdown */}
        <p
          style={{
            color: "rgba(255,255,255,0.65)",
            fontSize: "0.875rem",
            margin: 0,
          }}
        >
          {countdown > 0
            ? `Redirigiendo en ${countdown} s…`
            : "Redirigiendo…"}
        </p>
      </div>

      {/* Footer — opacity raised to 0.65 to meet WCAG 1.4.3 AA on dark gradient background */}
      <p
        style={{
          color: "rgba(255,255,255,0.65)",
          fontSize: "0.875rem",
          marginTop: "2rem",
          textAlign: "center",
        }}
      >
        Pago procesado con seguridad por Mercado Pago · somosvelora.com
      </p>
    </div>
  );
}
