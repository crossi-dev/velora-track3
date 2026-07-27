import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Velora — Terms of Service",
  description: "Velora Terms of Service. The conditions for using the application and the service.",
};

// eslint-disable-next-line max-lines-per-function -- composition root, not a logic violation
export default function TermsOfServicePageEn() {
  return (
    <div
      style={{
        minHeight: "100dvh",
        backgroundColor: "var(--background)",
        color: "var(--tone-strong)",
        fontFamily: "var(--font-dm-sans), sans-serif",
      }}
    >
      <div
        style={{
          maxWidth: "720px",
          margin: "0 auto",
          padding: "clamp(2rem, 5vw, 4rem) clamp(1rem, 4vw, 2rem)",
        }}
      >
        <a
          href="/"
          style={{
            display: "inline-block",
            marginBottom: "2rem",
            fontSize: "0.875rem",
            color: "var(--brand)",
            textDecoration: "none",
          }}
        >
          &larr; Back to Velora
        </a>

        <h1 style={{ fontSize: "clamp(1.75rem, 4vw, 2.25rem)", fontWeight: 700, lineHeight: 1.2, marginBottom: "0.5rem" }}>
          Terms of Service
        </h1>
        <p style={{ fontSize: "0.875rem", color: "var(--tone-muted)", marginBottom: "2.5rem" }}>
          Effective date: July 27, 2026
        </p>

        <p style={pStyle}>
          These Terms of Service (&ldquo;Terms&rdquo;) govern access to and use of Velora (&ldquo;we&rdquo;,
          &ldquo;our&rdquo;, or &ldquo;the application&rdquo;), an artificial-intelligence assistant that helps businesses
          manage sales, customers, products, stock, receipts, and commercial operations, operated from Argentina.
        </p>
        <p style={pStyle}>
          By using Velora you accept these Terms. If you do not agree, do not use the service.
        </p>

        {/* 1 */}
        <h2 style={h2Style}>1. Acceptance of terms</h2>
        <p style={pStyle}>
          By accessing or using Velora you confirm that you have read, understood, and accept these Terms, as well as our
          Privacy Policy. These Terms may be updated from time to time.
        </p>

        {/* 2 */}
        <h2 style={h2Style}>2. Use of the service</h2>
        <p style={pStyle}>You agree to use Velora in a lawful and responsible manner. In particular, you agree:</p>
        <ul style={ulStyle}>
          <li>Not to use the service for unlawful or unauthorized purposes</li>
          <li>Not to interfere with the operation or security of the application</li>
          <li>Not to attempt to access data belonging to other users or businesses</li>
          <li>To provide accurate information and keep it up to date</li>
        </ul>

        {/* 3 */}
        <h2 style={h2Style}>3. Accounts</h2>
        <p style={pStyle}>
          Some features require creating an account. You are responsible for maintaining the confidentiality of your
          credentials and for all activity that occurs under your account.
        </p>
        <p style={pStyle}>
          Notify us immediately if you detect any unauthorized use of your account.
        </p>

        {/* 4 */}
        <h2 style={h2Style}>4. AI agents acting on your behalf</h2>
        <p style={pStyle}>
          Velora operates through AI agents that take actions in your business on your behalf — recording sales,
          issuing invoices, coordinating shipments, and communicating with customers — based on your instructions and
          the permissions you grant. You remain responsible for reviewing agent activity and for the business
          decisions those actions carry out.
        </p>
        <p style={pStyle}>
          Every action an agent takes is logged and auditable from your account. Agents operate within the scope of
          the integrations you connect (e.g. payments, invoicing, shipping, messaging) and cannot act outside that
          scope. You can review, undo where technically possible, or revoke an integration&rsquo;s access at any time.
        </p>

        {/* 5 */}
        <h2 style={h2Style}>5. Payments</h2>
        <p style={pStyle}>
          Velora is currently offered free of charge during private beta. Pricing beyond the beta period is not yet
          defined and will be disclosed before any charge applies. Where a fee applies to a feature, billing terms
          will be shown before purchase.
        </p>
        <p style={pStyle}>
          Payments made through third-party providers (e.g. MercadoPago) are additionally governed by those
          providers&rsquo; own terms.
        </p>

        {/* 6 */}
        <h2 style={h2Style}>6. Limitation of liability</h2>
        <p style={pStyle}>
          Velora is provided &ldquo;as is&rdquo; and &ldquo;as available&rdquo;. To the maximum extent permitted by law,
          we do not warrant that the service will be uninterrupted or error-free.
        </p>
        <p style={pStyle}>
          We shall not be liable for indirect, incidental, or consequential damages arising from the use of, or inability
          to use, the service.
        </p>

        {/* 7 */}
        <h2 style={h2Style}>7. Changes</h2>
        <p style={pStyle}>
          We may modify these Terms or the service at any time. If we make material changes, we will update the effective
          date shown above. Continued use of the service constitutes acceptance of the current Terms.
        </p>

        {/* 8 */}
        <h2 style={h2Style}>8. Governing law and jurisdiction</h2>
        <p style={pStyle}>
          These Terms are governed by the laws of Argentina. Any dispute arising from these Terms or the use of
          Velora will be submitted to the ordinary courts of the Autonomous City of Buenos Aires, Argentina, waiving
          any other jurisdiction that may apply.
        </p>

        {/* 9 */}
        <h2 style={h2Style}>9. Contact</h2>
        <p style={pStyle}>If you have questions about these Terms, you can write to us at:</p>
        <p style={pStyle}>
          <a href="mailto:soporte@somosvelora.com" style={linkStyle}>soporte@somosvelora.com</a>
        </p>
        <p style={{ ...pStyle, marginTop: "2rem", color: "var(--tone-muted)", fontSize: "0.875rem" }}>
          Velora &mdash;{" "}
          <a href="https://somosvelora.com" style={linkStyle}>somosvelora.com</a>
        </p>
      </div>
    </div>
  );
}

const pStyle: React.CSSProperties = {
  fontSize: "1rem",
  lineHeight: 1.7,
  marginBottom: "1rem",
  color: "var(--tone-body)",
};

const h2Style: React.CSSProperties = {
  fontSize: "1.5rem",
  fontWeight: 700,
  lineHeight: 1.3,
  marginTop: "2.5rem",
  marginBottom: "1rem",
  color: "var(--tone-strong)",
};

const ulStyle: React.CSSProperties = {
  paddingLeft: "1.5rem",
  marginBottom: "1rem",
  lineHeight: 1.8,
  color: "var(--tone-body)",
};

const linkStyle: React.CSSProperties = {
  color: "var(--brand)",
  textDecoration: "underline",
  textUnderlineOffset: "3px",
};
