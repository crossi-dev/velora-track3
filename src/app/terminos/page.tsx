{/* DRAFT — contenido legal pendiente de revisión legal. */}
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Velora — Términos de Servicio",
  description: "Términos de Servicio de Velora. Condiciones de uso de la aplicación y el servicio.",
};

// eslint-disable-next-line max-lines-per-function -- composition root, not a logic violation
export default function TermsOfServicePage() {
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
          &larr; Volver a Velora
        </a>

        <h1 style={{ fontSize: "clamp(1.75rem, 4vw, 2.25rem)", fontWeight: 700, lineHeight: 1.2, marginBottom: "0.5rem" }}>
          Términos de Servicio
        </h1>
        <p style={{ fontSize: "0.875rem", color: "var(--tone-muted)", marginBottom: "2.5rem" }}>
          Fecha de vigencia: 4 de junio de 2026
        </p>

        <p style={pStyle}>
          Estos Términos de Servicio (&ldquo;Términos&rdquo;) regulan el acceso y uso de Velora
          (&ldquo;nosotros&rdquo;, &ldquo;nuestro&rdquo; o &ldquo;la aplicación&rdquo;), un asistente de inteligencia
          artificial que ayuda a negocios a gestionar ventas, clientes, productos, stock, comprobantes y operaciones comerciales.
        </p>
        <p style={pStyle}>
          Al usar Velora aceptás estos Términos. Si no estás de acuerdo, no utilices el servicio.
        </p>

        {/* 1 */}
        <h2 style={h2Style}>1. Aceptación de los términos</h2>
        <p style={pStyle}>
          Al acceder o usar Velora confirmás que leíste, entendiste y aceptás estos Términos, así como nuestra
          Política de Privacidad. Estos Términos pueden actualizarse periódicamente.
        </p>

        {/* 2 */}
        <h2 style={h2Style}>2. Uso del servicio</h2>
        <p style={pStyle}>Te comprometés a usar Velora de manera lícita y responsable. En particular, aceptás:</p>
        <ul style={ulStyle}>
          <li>No utilizar el servicio para fines ilegales o no autorizados</li>
          <li>No interferir con el funcionamiento o la seguridad de la aplicación</li>
          <li>No intentar acceder a datos de otros usuarios o negocios</li>
          <li>Proporcionar información veraz y mantenerla actualizada</li>
        </ul>

        {/* 3 */}
        <h2 style={h2Style}>3. Cuentas</h2>
        <p style={pStyle}>
          Para usar ciertas funciones es necesario crear una cuenta. Sos responsable de mantener la confidencialidad de
          tus credenciales y de toda la actividad que ocurra bajo tu cuenta.
        </p>
        <p style={pStyle}>
          Notificanos de inmediato si detectás un uso no autorizado de tu cuenta.
        </p>

        {/* 4 */}
        <h2 style={h2Style}>4. Pagos</h2>
        <p style={pStyle}>
          Algunas funciones pueden ofrecerse de forma gratuita y otras pueden requerir un pago. Cuando corresponda, las
          condiciones de precio y facturación se informarán antes de la contratación.
        </p>
        <p style={pStyle}>
          Los pagos a través de proveedores externos se rigen además por los términos de dichos proveedores.
        </p>

        {/* 5 */}
        <h2 style={h2Style}>5. Limitación de responsabilidad</h2>
        <p style={pStyle}>
          Velora se provee &ldquo;tal cual&rdquo; y &ldquo;según disponibilidad&rdquo;. En la máxima medida permitida por
          la ley, no garantizamos que el servicio sea ininterrumpido o libre de errores.
        </p>
        <p style={pStyle}>
          No seremos responsables por daños indirectos, incidentales o consecuentes derivados del uso o la imposibilidad
          de uso del servicio.
        </p>

        {/* 6 */}
        <h2 style={h2Style}>6. Cambios</h2>
        <p style={pStyle}>
          Podemos modificar estos Términos o el servicio en cualquier momento. Si realizamos cambios importantes,
          actualizaremos la fecha de vigencia indicada arriba. El uso continuado del servicio implica la aceptación de
          los Términos vigentes.
        </p>

        {/* 7 */}
        <h2 style={h2Style}>7. Contacto</h2>
        <p style={pStyle}>Si tenés preguntas sobre estos Términos, podés escribirnos a:</p>
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
