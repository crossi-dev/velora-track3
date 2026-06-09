// Branded error page for the public payment landing — two variants:
//
//   "expired"  — intent estado is not "pending" or "confirmed" (cancelled,
//                expired, refunded, etc.). Customer should contact the seller.
//
//   "invalid"  — checkoutUrl failed the MP origin allowlist. Open-redirect
//                blocked; render an informative page, not a bare 404.
//
// Design: matches PayLandingClient card aesthetics (dark gradient, glass card,
// WCAG 2.2 AA contrast). Server Component — no "use client" needed.
//
// Ref: Next.js App Router — notFound() is reserved for "record doesn't exist".
// Controlled business/security states render inline branded components instead
// of triggering the Next.js not-found shell.
// https://nextjs.org/docs/app/api-reference/file-conventions/error (Next.js 16, 2026)

interface Props {
  variant: "expired" | "invalid";
  paymentIntentId: string;
}

const CARD_STYLE: React.CSSProperties = {
  background: "rgba(255,255,255,0.05)",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: "1.5rem",
  padding: "2.5rem 2rem",
  maxWidth: "420px",
  width: "100%",
  textAlign: "center",
  backdropFilter: "blur(12px)",
};

const WRAPPER_STYLE: React.CSSProperties = {
  minHeight: "100dvh",
  background: "linear-gradient(135deg, #1B3A6B 0%, #0F2347 60%, #0a1a35 100%)",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  padding: "2rem 1.25rem",
  fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
};

export function PayLandingError({ variant }: Props) {
  const isExpired = variant === "expired";

  const icon = isExpired ? "⏱" : "🔒";
  const heading = isExpired ? "Este link ya no está disponible" : "Link inválido";
  const body = isExpired
    ? "El link de pago venció o ya fue procesado. Contactá al vendedor para que te genere uno nuevo."
    : "Este link de pago no es válido. Si recibiste este link por WhatsApp y creés que es un error, contactá al vendedor.";

  return (
    <div style={WRAPPER_STYLE}>
      <div style={CARD_STYLE}>
        {/* Logo mark */}
        <div
          style={{
            width: "3rem",
            height: "3rem",
            borderRadius: "50%",
            background: "radial-gradient(circle at 30% 30%, #4A7FBF, #1B3A6B 70%)",
            boxShadow:
              "inset 0 0 0 1px rgba(255,255,255,0.25), 0 4px 20px rgba(74,127,191,0.4)",
            margin: "0 auto 1.25rem",
          }}
        />

        {/* Wordmark — opacity 0.87 meets WCAG 1.4.3 AA 4.5:1 on darkest gradient point */}
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

        {/* Icon */}
        <p
          style={{
            fontSize: "2.5rem",
            margin: "0 0 1rem",
            lineHeight: 1,
          }}
          aria-hidden="true"
        >
          {icon}
        </p>

        {/* Heading */}
        <p
          style={{
            color: "#fff",
            fontSize: "1.25rem",
            fontWeight: 700,
            lineHeight: 1.3,
            margin: "0 0 1rem",
          }}
        >
          {heading}
        </p>

        {/* Body */}
        <p
          style={{
            color: "rgba(255,255,255,0.75)",
            fontSize: "1rem",
            lineHeight: 1.5,
            margin: 0,
          }}
        >
          {body}
        </p>
      </div>

      {/* Footer — opacity 0.65 meets WCAG 1.4.3 AA on dark gradient background */}
      <p
        style={{
          color: "rgba(255,255,255,0.65)",
          fontSize: "0.875rem",
          marginTop: "2rem",
          textAlign: "center",
        }}
      >
        somosvelora.com
      </p>
    </div>
  );
}
