import type { HeaderCopy } from "./Header";
import type { HeroCopy } from "./Hero";
import type { BenefitsCopy } from "./Benefits";
import type { StepsCopy } from "./Steps";
import type { QuietRowCopy } from "./QuietRow";
import type { SurfacesCopy } from "./Surfaces";
import type { WidgetsCopy } from "./Widgets";
import type { IntegracionesCopy } from "./Integraciones";
import type { FAQCopy } from "./FAQ";
import type { ClosingCopy } from "./ClosingCTA";
import type { FooterCopy } from "./Footer";

export type LandingCopy = {
  header: HeaderCopy;
  hero: HeroCopy;
  benefits: BenefitsCopy;
  steps: StepsCopy;
  quiet: QuietRowCopy;
  surfaces: SurfacesCopy;
  widgets: WidgetsCopy;
  integraciones: IntegracionesCopy;
  faq: FAQCopy;
  closing: ClosingCopy;
  footer: FooterCopy;
};

/* Default AR-tuned copy (es-AR). Hero = benefit-first; body = the 3-surfaces
   + graphical-widgets story. Enterprise / B2B register, honest, no invented metrics. */
export const defaultCopy: LandingCopy = {
  header: {
    wordmark: "Velora",
    nav: [
      { label: "Cómo funciona", href: "#como-funciona" },
      { label: "Dónde usarlo", href: "#superficies" },
      { label: "Integraciones", href: "#integraciones" },
      { label: "Preguntas", href: "#preguntas" },
    ],
    switcher: { es: "ES", en: "EN", aria: "Cambiar idioma" },
    cta: "Empezá gratis",
  },
  hero: {
    wordmark: "VELORA",
    verb: "Vendé sin estar.",
    tagline:
      "Manejá tu negocio con IA. Ventas, stock, cobros — todo desde el chat. Tu equipo de agentes de IA trabaja mientras vos dirigís.",
    taglineStrong: "Desde la Velora App, ChatGPT, Claude o Gemini.",
    ctaLabel: "Empezá con Google",
    ctaMicroTrust: "Gratis en beta · sin tarjeta",
  },
  benefits: {
    label: "Capacidades",
    headline: "Del primer mensaje al despacho, solo.",
    items: [
      {
        title: "Vendé y cobrá",
        body: "El agente atiende por WhatsApp, arma el pedido, genera el link de pago y confirma la cobranza — sin que estés.",
      },
      {
        title: "Facturá y despachá",
        body: "Emitís la factura con ARCA y coordinás el envío con el correo. Agente a agente, sin formularios.",
      },
      {
        title: "Operalo desde cualquier IA",
        body: "Usá la Velora App, ChatGPT o Claude. El mismo negocio, manejado desde la superficie que ya usás.",
      },
    ],
  },
  steps: {
    items: [
      { n: "01", verb: "Entra el pedido por WhatsApp" },
      { n: "02", verb: "El agente vende y cobra" },
      { n: "03", verb: "Factura y despacha solo" },
    ],
  },
  quiet: {
    items: [
      "Construido sobre estándares abiertos — MCP + A2A.",
      "Interoperable con Claude, ChatGPT y Gemini.",
      "Identidad criptográfica y trazabilidad por agente.",
    ],
  },
  surfaces: {
    label: "Dónde usarlo",
    headline: "Usá Velora donde ya trabajás.",
    sub: "Tres puntos de entrada, el mismo negocio. Elegís el que se ajusta a cómo operás hoy — sin perder nada. Gemini ya opera Velora directo vía MCP — miralo en Integraciones.",
    entries: [
      {
        name: "Velora App",
        description:
          "La app nativa de Velora. Entrás con Google, configurás tu negocio en el chat y empezás a operar en minutos. Construida sobre infraestructura Google, con identidad criptográfica por agente.",
        badge: "Disponible",
        available: true,
        ctaLabel: "Empezá con Google",
        ctaHref: "#",
      },
      {
        name: "ChatGPT",
        description:
          "Velora como toolkit dentro de ChatGPT. Consultá el catálogo, registrá ventas y seguí el stock sin salir de la conversación. Conectado vía el estándar abierto MCP.",
        badge: "Disponible vía MCP · directorio próximamente",
        available: false,
      },
      {
        name: "Claude / Cowork",
        description:
          "Operá Velora desde Claude. Ideal si ya usás Cowork para tu día a día: el mismo chat gestiona el negocio y tus herramientas de trabajo. Conectado vía MCP.",
        badge: "Disponible vía MCP · directorio próximamente",
        available: false,
      },
    ],
  },
  widgets: {
    label: "Experiencia",
    headline: "No es texto plano. Son widgets.",
    sub: "Velora no te tira datos crudos al chat. En cada paso crítico aparece un widget interactivo: revisás, confirmás y seguís el estado en tiempo real.",
    steps: [
      {
        n: "01",
        title: "Wizard de cobro",
        body: "Cuando llega la hora de cobrar, Velora despliega un wizard con el detalle del pedido, el monto y el método. Vos confirmás — el agente ejecuta.",
      },
      {
        n: "02",
        title: "Estado del cobro en vivo",
        body: "Un widget de estado te muestra si el pago está pendiente, procesando o confirmado. Sin refrescar, sin preguntar al cliente.",
      },
      {
        n: "03",
        title: "Comprobante listo",
        body: "Cobro confirmado. Velora genera el comprobante y lo manda por WhatsApp — el cliente lo recibe antes de que vos cierres el chat.",
      },
    ],
  },
  integraciones: {
    title: "Integraciones",
    headline: "Velora vive dentro de tu IA.",
    sub: "Claude, ChatGPT o Gemini operan Velora vía el estándar abierto MCP. El mismo negocio, manejado desde la IA que ya usás.",
    endpoint: "Conectá tu agente a tools.somosvelora.com/api/mcp",
    cards: [
      {
        name: "Claude",
        imageAlt:
          "Claude vendiendo en Velora: encuentra al cliente, verifica el stock y genera el link de pago de MercadoPago",
        caption: "Vendés y cobrás: cliente, stock y link de pago en un mensaje.",
        imageSrc: "/integraciones/claude-3-vender.jpg",
        hasScreenshot: true,
      },
      {
        name: "ChatGPT",
        imageAlt:
          "ChatGPT consultando el catálogo de Velora: lista de productos con precio y stock",
        caption: "Consultás todo tu catálogo y stock al instante.",
        imageSrc: "/integraciones/chatgpt-catalogo.jpg",
        hasScreenshot: true,
      },
      {
        name: "Gemini",
        imageAlt:
          "Sesión real de Gemini CLI consultando el catálogo de Velora vía MCP: Gemini llama a mcp_velora_query_catalog y lista los productos con stock en vivo",
        caption: "Gemini opera Velora vía MCP — en vivo.",
        imageSrc: "/integraciones/gemini-cli-velora.jpg",
        hasScreenshot: true,
      },
    ],
  },
  faq: {
    /* Title is split into three parts so the middle word can be italicised. */
    title: ["Lo que ", "probablemente", " querés saber."],
    subtitle: "Si falta algo, escribinos a gestiones@somosvelora.com.",
    items: [
      {
        q: "¿Qué es Velora?",
        a: "Una plataforma de comercio agéntico: agentes de IA que venden, cobran, facturan y despachan de punta a punta, interoperan agente a agente, y se operan desde la Velora App, ChatGPT, Claude o Gemini.",
      },
      {
        q: "¿Desde dónde puedo usar Velora?",
        a: "Desde tres superficies: la Velora App (disponible ahora, entrás con Google), o como toolkit dentro de ChatGPT o Claude vía el estándar MCP — conectalos hoy con el endpoint público; los listados en los directorios oficiales están en camino. Gemini ya se conecta hoy directamente al endpoint MCP — sin necesidad de directorio. El mismo negocio desde cualquiera de las tres.",
      },
      {
        q: "¿Los widgets del chat son reales?",
        a: "Sí. Cuando Velora necesita que confirmes un cobro, te muestra un widget con el detalle — no solo texto. El estado del pago se actualiza en el mismo chat sin que tengas que preguntar.",
      },
      {
        q: "¿Es seguro?",
        a: "Sí. Velora corre sobre Vertex AI y el protocolo A2A, con identidad criptográfica por agente y trazabilidad completa de cada acción que ejecuta en tu nombre.",
      },
      {
        q: "¿Y si el agente se equivoca?",
        a: "Vos tenés el control. Cada acción queda registrada y la podés revisar o deshacer desde el chat. Nada se ejecuta a tus espaldas.",
      },
      {
        q: "¿Necesito conocer de tecnología?",
        a: "No. Velora conversa en castellano rioplatense y entiende cómo trabajás. Si sabés mandar un audio o un WhatsApp, sabés operar Velora.",
      },
      {
        q: "¿Cuánto cuesta?",
        a: "En definición. La beta privada es sin costo mientras dure. Escribinos para coordinar acceso anticipado.",
      },
      {
        q: "¿Cómo me conecto con mi proveedor?",
        a: "Velora habla A2A con Andreani, MercadoPago, ARCA y otros agentes empresariales. Si tu proveedor todavía no expone un agente, podemos conectarlo por API en horas.",
      },
    ],
  },
  closing: {
    headline: "Manejá tu negocio con IA, desde donde quieras.",
    ctaLabel: "Empezá gratis con Google",
    microTrust: "Gratis en beta · sin tarjeta",
  },
  footer: {
    copyright: "© 2026 Velora",
    links: [
      { label: "Privacidad", href: "/privacy" },
      { label: "Términos", href: "/terminos" },
    ],
    contactEmail: "gestiones@somosvelora.com",
  },
};

/* English copy lives in landing-copy.en.ts to keep this file under the 300-line limit. */
export { defaultCopyEn } from "./landing-copy.en";
