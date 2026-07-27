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
          Fecha de vigencia: 27 de julio de 2026
        </p>

        <p style={pStyle}>
          Estos Términos de Servicio (&ldquo;Términos&rdquo;) regulan el acceso y uso de Velora
          (&ldquo;nosotros&rdquo;, &ldquo;nuestro&rdquo; o &ldquo;la aplicación&rdquo;), un asistente de inteligencia
          artificial que ayuda a negocios a gestionar ventas, clientes, productos, stock, comprobantes y operaciones
          comerciales, operado desde Argentina.
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
        <h2 style={h2Style}>4. Agentes de IA que actúan en tu nombre</h2>
        <p style={pStyle}>
          Velora opera mediante agentes de IA que ejecutan acciones en tu negocio en tu nombre — registrar ventas,
          emitir facturas, coordinar envíos y comunicarse con clientes — según tus instrucciones y los permisos que
          otorgues. Vos seguís siendo responsable de revisar la actividad de los agentes y de las decisiones
          comerciales que esas acciones ejecutan.
        </p>
        <p style={pStyle}>
          Toda acción que ejecuta un agente queda registrada y es auditable desde tu cuenta. Los agentes operan
          dentro del alcance de las integraciones que conectás (por ejemplo pagos, facturación, envíos, mensajería) y
          no pueden actuar fuera de ese alcance. Podés revisar, deshacer cuando sea técnicamente posible, o revocar
          el acceso de una integración en cualquier momento.
        </p>

        {/* 5 */}
        <h2 style={h2Style}>5. Pagos</h2>
        <p style={pStyle}>
          Velora se ofrece actualmente sin costo durante la beta privada. El precio posterior a la beta todavía no
          está definido y se informará antes de que se aplique cualquier cobro. Cuando una función tenga costo, las
          condiciones de facturación se mostrarán antes de la contratación.
        </p>
        <p style={pStyle}>
          Los pagos a través de proveedores externos (por ejemplo MercadoPago) se rigen además por los términos
          propios de esos proveedores.
        </p>

        {/* 6 */}
        <h2 style={h2Style}>6. Limitación de responsabilidad</h2>
        <p style={pStyle}>
          Velora se provee &ldquo;tal cual&rdquo; y &ldquo;según disponibilidad&rdquo;. En la máxima medida permitida por
          la ley, no garantizamos que el servicio sea ininterrumpido o libre de errores.
        </p>
        <p style={pStyle}>
          No seremos responsables por daños indirectos, incidentales o consecuentes derivados del uso o la imposibilidad
          de uso del servicio.
        </p>

        {/* 7 */}
        <h2 style={h2Style}>7. Cambios</h2>
        <p style={pStyle}>
          Podemos modificar estos Términos o el servicio en cualquier momento. Si realizamos cambios importantes,
          actualizaremos la fecha de vigencia indicada arriba. El uso continuado del servicio implica la aceptación de
          los Términos vigentes.
        </p>

        {/* 8 */}
        <h2 style={h2Style}>8. Ley aplicable y jurisdicción</h2>
        <p style={pStyle}>
          Estos Términos se rigen por las leyes de la República Argentina. Cualquier controversia derivada de estos
          Términos o del uso de Velora se someterá a los tribunales ordinarios de la Ciudad Autónoma de Buenos Aires,
          Argentina, renunciando a cualquier otro fuero que pudiera corresponder.
        </p>

        {/* 9 */}
        <h2 style={h2Style}>9. Contacto</h2>
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
