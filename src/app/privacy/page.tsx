import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Velora — Política de Privacidad",
  description: "Política de Privacidad de Velora. Cómo recopilamos, usamos y protegemos tu información.",
};

// eslint-disable-next-line max-lines-per-function -- composition root, not a logic violation
export default function PrivacyPolicyPage() {
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
          Política de Privacidad
        </h1>
        <p style={{ fontSize: "0.875rem", color: "var(--tone-muted)", marginBottom: "2.5rem" }}>
          Última actualización: 8 de junio de 2026
        </p>

        <p style={pStyle}>
          Velora (&ldquo;nosotros&rdquo;, &ldquo;nuestro&rdquo; o &ldquo;la aplicación&rdquo;) es un asistente de inteligencia artificial
          que ayuda a pequeños negocios a gestionar ventas, clientes, productos, stock, comprobantes y operaciones comerciales.
        </p>
        <p style={pStyle}>
          Esta Política de Privacidad explica qué información recopilamos, cómo la usamos, cuándo la compartimos y qué opciones tenés.
        </p>

        {/* 1 */}
        <h2 style={h2Style}>1. Información que recopilamos</h2>

        <h3 style={h3Style}>Información de la cuenta</h3>
        <p style={pStyle}>Podemos recopilar:</p>
        <ul style={ulStyle}>
          <li>Nombre</li>
          <li>Correo electrónico</li>
          <li>Información de tu cuenta de Google si iniciás sesión con Google</li>
          <li>Nombre de tu negocio y configuración del negocio</li>
        </ul>

        <h3 style={h3Style}>Datos del negocio</h3>
        <p style={pStyle}>Velora guarda la información que ingresás en la aplicación, por ejemplo:</p>
        <ul style={ulStyle}>
          <li>Productos</li>
          <li>Clientes y proveedores</li>
          <li>Ventas y comprobantes</li>
          <li>Stock y movimientos de inventario</li>
          <li>Caja y registros del negocio</li>
          <li>Notas y mensajes ingresados al asistente</li>
        </ul>

        <h3 style={h3Style}>Uso del micrófono</h3>
        <p style={pStyle}>
          Si elegís usar las funciones de voz, Velora puede acceder al micrófono de tu dispositivo únicamente mientras
          estás usando el ingreso por voz.
        </p>
        <p style={pStyle}>
          Las grabaciones o transcripciones de voz se utilizan solo para procesar tu solicitud y no se usan para publicidad.
        </p>

        <h3 style={h3Style}>Información técnica</h3>
        <p style={pStyle}>También podemos recopilar automáticamente:</p>
        <ul style={ulStyle}>
          <li>Tipo de dispositivo</li>
          <li>Sistema operativo</li>
          <li>Navegador</li>
          <li>Versión de la aplicación</li>
          <li>Errores, fallos y registros técnicos</li>
          <li>Información de diagnóstico</li>
        </ul>
        <p style={pStyle}>
          Utilizamos Cloud Error Reporting de Google para recopilar información técnica sobre errores y así detectar y
          corregir problemas.
        </p>

        {/* 2 */}
        <h2 style={h2Style}>2. Cómo usamos tu información</h2>
        <p style={pStyle}>Usamos tu información para:</p>
        <ul style={ulStyle}>
          <li>Proveer y operar Velora</li>
          <li>Guardar y sincronizar los datos de tu negocio</li>
          <li>Generar comprobantes, PDFs y enlaces para compartir por WhatsApp</li>
          <li>Procesar comandos de voz y texto mediante inteligencia artificial</li>
          <li>Mejorar el reconocimiento de voz y las respuestas del asistente</li>
          <li>Detectar errores, fallos y problemas de seguridad</li>
          <li>Brindar soporte</li>
          <li>Cumplir obligaciones legales</li>
        </ul>
        <p style={{ ...pStyle, fontWeight: 600 }}>No vendemos tu información personal.</p>

        {/* 3 */}
        <h2 style={h2Style}>3. Cuándo compartimos información</h2>
        <p style={pStyle}>Solo compartimos información cuando es necesario para que Velora funcione.</p>
        <p style={pStyle}>Velora puede utilizar proveedores externos como:</p>
        <ul style={ulStyle}>
          <li><strong>Google</strong> — inicio de sesión (OAuth), infraestructura de hosting (Cloud Run), base de datos (Supabase), y modelos de inteligencia artificial (Google AI / Gemini) para procesar comandos de voz y texto.</li>
          <li><strong>MercadoPago</strong> — procesamiento de pagos. Cuando generás un link de cobro, Velora crea una preferencia de pago en MercadoPago. El ingreso de datos de tarjeta ocurre exclusivamente en el sitio de MercadoPago; Velora nunca recibe ni almacena datos de tarjetas de crédito o débito.</li>
          <li><strong>ARCA / AFIP</strong> — facturación electrónica. Cuando emitís una factura, Velora envía a ARCA (Agencia de Recaudación y Control Aduanero) los datos fiscales requeridos por ley: CUIT del cliente, monto, tipo de comprobante y concepto. La retención de esos datos en ARCA está regida por la normativa fiscal argentina.</li>
          <li><strong>WhatsApp / Meta</strong> — envío de mensajes, comprobantes y notificaciones al cliente vía WhatsApp Business API de Meta.</li>
          <li><strong>Andreani / OCA</strong> — logística y envíos. Si usás herramientas de cotización o creación de envíos, los datos necesarios para el despacho (dirección, código postal, DNI del destinatario cuando el courier lo requiere) se transmiten al courier seleccionado.</li>
          <li><strong>Servicios de monitoreo</strong> — Cloud Error Reporting de Google, para detectar y corregir errores técnicos.</li>
        </ul>
        <p style={pStyle}>
          Estos proveedores reciben únicamente la información mínima necesaria para cumplir su función.
        </p>
        <p style={pStyle}>
          También podemos compartir información si es requerido por la ley o para proteger la seguridad e integridad del servicio.
        </p>

        {/* 4 */}
        <h2 style={h2Style}>4. Retención de datos</h2>
        <p style={pStyle}>
          Velora retiene los datos mientras tu cuenta esté activa o mientras sean necesarios para prestar el servicio.
          Cuando eliminás tu cuenta, eliminamos los datos personales asociados a pedido tuyo (escribinos a{" "}
          <a href="mailto:soporte@somosvelora.com" style={linkStyle}>soporte@somosvelora.com</a>).
        </p>
        <p style={pStyle}>Plazos de retención por tipo de dato:</p>
        <ul style={ulStyle}>
          <li><strong>Registros de auditoría y eventos críticos</strong> (operaciones financieras, accesos): 90 días, luego eliminados automáticamente.</li>
          <li><strong>Historial de conversaciones</strong> (mensajes del asistente): 90 días, luego eliminados automáticamente.</li>
          <li><strong>Registros de movimientos de stock y caja</strong>: 365 días (un año), por requisitos mínimos de trazabilidad financiera.</li>
          <li><strong>Registros de eventos de agentes A2A</strong> (diagnóstico): 180 días.</li>
          <li><strong>Sesiones de usuario</strong>: eliminadas al expirar (según la configuración de NextAuth).</li>
          <li><strong>Datos operativos del negocio</strong> (catálogo, clientes, ventas, facturas): retenidos mientras la cuenta esté activa. No tienen TTL automático; se eliminan cuando se solicita la baja de la cuenta.</li>
          <li><strong>Credenciales de integraciones</strong> (token de MercadoPago, credenciales de PedidosYa): almacenadas cifradas con AES-256-GCM; retenidas hasta que reconectés o des de baja la integración.</li>
        </ul>
        <p style={pStyle}>
          Los plazos indicados corresponden al comportamiento actual del sistema de limpieza automática de Velora
          (cron <em>audit-cleanup</em>, que corre diariamente). Pueden ajustarse en el futuro conforme a obligaciones
          legales o de servicio.
        </p>

        {/* 5 */}
        <h2 style={h2Style}>5. Uso de Velora como herramienta de IA (MCP)</h2>
        <p style={pStyle}>
          Velora puede conectarse como toolkit MCP (<em>Model Context Protocol</em>) a asistentes de IA de terceros,
          como ChatGPT (OpenAI) o Claude (Anthropic). Cuando el dueño del negocio realiza esa conexión, el asistente
          de IA conectado puede invocar las herramientas de Velora para leer y actuar sobre los datos del propio
          negocio (catálogo, clientes, ventas, stock, caja) bajo la sesión autenticada del dueño.
        </p>
        <p style={pStyle}>
          Esta integración tiene las siguientes garantías:
        </p>
        <ul style={ulStyle}>
          <li>El acceso MCP requiere autenticación del dueño del negocio; no está disponible sin credenciales válidas.</li>
          <li>Velora no comparte los datos de un negocio con otro (aislamiento por tenant). Cada negocio accede exclusivamente a su propia información.</li>
          <li>Los datos leídos o modificados a través de MCP son los mismos datos del negocio descritos en esta política. No se crea una copia adicional ni se transmiten a Velora datos del asistente de IA.</li>
          <li>Las herramientas de conexión de integraciones (que aceptan credenciales) están excluidas de la superficie MCP pública; la configuración de integraciones se realiza desde el panel de Velora.</li>
        </ul>

        {/* 6 — original 4 */}
        <h2 style={h2Style}>6. Seguridad de los datos</h2>
        <p style={pStyle}>Tomamos medidas razonables para proteger tu información.</p>
        <p style={pStyle}>Tus datos pueden almacenarse en infraestructura y bases de datos seguras.</p>
        <p style={pStyle}>
          Sin embargo, ningún sistema es completamente seguro y no podemos garantizar seguridad absoluta.
        </p>

        {/* 7 */}
        <h2 style={h2Style}>7. Tus derechos</h2>
        <p style={pStyle}>Podés:</p>
        <ul style={ulStyle}>
          <li>Acceder y actualizar tu información</li>
          <li>Eliminar clientes, productos y registros desde la aplicación</li>
          <li>Solicitar la eliminación de tu cuenta y datos asociados</li>
          <li>Desactivar el permiso de micrófono desde la configuración de tu dispositivo</li>
        </ul>
        <p style={pStyle}>Para solicitar la eliminación de tu cuenta o tus datos, escribinos a:</p>
        <p style={pStyle}>
          <a href="mailto:soporte@somosvelora.com" style={linkStyle}>soporte@somosvelora.com</a>
        </p>

        {/* 8 */}
        <h2 style={h2Style}>8. Menores de edad</h2>
        <p style={pStyle}>
          Velora no está dirigida a menores de 13 años y no recopilamos intencionalmente información personal de menores.
        </p>

        {/* 9 */}
        <h2 style={h2Style}>9. Usuarios de otros países</h2>
        <p style={pStyle}>
          Si usás Velora desde otro país, tu información puede procesarse en países donde operen nuestros proveedores.
        </p>

        {/* 10 */}
        <h2 style={h2Style}>10. Cambios a esta política</h2>
        <p style={pStyle}>Podemos actualizar esta Política de Privacidad de vez en cuando.</p>
        <p style={pStyle}>
          Si realizamos cambios importantes, actualizaremos la fecha de vigencia indicada arriba.
        </p>

        {/* 11 */}
        <h2 style={h2Style}>11. Contacto</h2>
        <p style={pStyle}>Si tenés preguntas sobre esta Política de Privacidad, podés escribirnos a:</p>
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

const h3Style: React.CSSProperties = {
  fontSize: "1.125rem",
  fontWeight: 600,
  lineHeight: 1.3,
  marginTop: "1.5rem",
  marginBottom: "0.75rem",
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
