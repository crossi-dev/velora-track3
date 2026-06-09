// Lightweight i18n for the landing page. Detects locale from the
// `Accept-Language` request header (server-side, in the layout); also
// honors a `NEXT_LOCALE` cookie that the LanguageSwitcher writes when the
// user explicitly toggles.
//
// Two locales:
//   - es-AR (default for Argentine target market)
//   - en    (Track 3 judges, English-speaking visitors)
//
// Browser-language detection follows the Next.js App Router i18n guide:
//   https://nextjs.org/docs/app/building-your-application/routing/internationalization
// Uses `negotiator` + `@formatjs/intl-localematcher` for standard
// Accept-Language negotiation (same approach shown in official docs).
//
// We deliberately do not pull in next-intl. The full i18n surface for
// Velora is small enough that two flat dictionaries and a t() lookup are
// the right amount of machinery. If we add a third locale later, swap in
// next-intl then.

import { match } from "@formatjs/intl-localematcher";
import Negotiator from "negotiator";

export type Locale = "es-AR" | "en";

export const LOCALE_COOKIE = "NEXT_LOCALE";

const SUPPORTED_LOCALES: Locale[] = ["es-AR", "en"];
const DEFAULT_LOCALE: Locale = "es-AR";

export function pickLocale(acceptLanguage: string | null, cookieLocale: string | null): Locale {
  // Cookie wins — if the user explicitly toggled, respect that.
  if (cookieLocale === "en") return "en";
  if (cookieLocale === "es-AR" || cookieLocale === "es") return "es-AR";

  // Negotiate from the browser's Accept-Language header using the
  // @formatjs/intl-localematcher + negotiator approach documented at:
  // https://nextjs.org/docs/app/building-your-application/routing/internationalization
  if (acceptLanguage) {
    try {
      const headers = { "accept-language": acceptLanguage };
      const languages = new Negotiator({ headers }).languages();
      const matched = match(languages, SUPPORTED_LOCALES, DEFAULT_LOCALE) as Locale;
      return matched;
    } catch {
      // Fall through to default if negotiation fails (e.g. malformed header).
    }
  }

  return DEFAULT_LOCALE;
}

export interface RolePickerDict {
  groupLabel: string;
  ownerLabel: string;
  ownerSub: string;
  ownerAriaLabel: string;
  staffLabel: string;
  staffSub: string;
  staffAriaLabel: string;
  staffFormLabel: string;
  codeLabel: string;
  codePlaceholder: string;
  submitLabel: string;
  submitLoading: string;
  noCodeHelp: string;
  backLabel: string;
  backAriaLabel: string;
  invalidCode: string;
}

export interface LandingDict {
  nav: { howItWorks: string; faq: string; support: string; getStarted: string };
  rolePicker: RolePickerDict;
  hero: {
    tagline: string;
    eyebrow: string;
    headline: string;
    headlineEm: string;
    lede: string;
    ctaPrimary: string;
    ctaWhatsApp: string;
    ctaMeta: string;
    ctaPrivacy: string;
    voiceMockup: {
      cashierLine1: string;
      cashierLine1Meta: string;
      assistantLine1: string;
      assistantLine1Sub: string;
      cashierLine2: string;
      cashierLine2Meta: string;
      assistantLine2Pre: string;
      assistantLine2Highlight: string;
      assistantLine2Post: string;
      assistantLine2Sub: string;
      micLabel: string;
    };
  };
  connecting: string;
  trust: string[];
  how: {
    label: string;
    h2: string;
    sub: string;
    steps: { title: string; body: string }[];
  };
  features: {
    label: string;
    h2: string;
    sub: string;
    cards: { title: string; body: string }[];
    visuals: { cash: { today: string; vsYesterday: string } };
  };
  faq: { label: string; h2: string; items: { q: string; a: string }[] };
  cta: { h2: string; sub: string; button: string; small: string };
  stickyCta: { title: string; sub: string; button: string };
  footer: { copy: string; links: { privacy: string; how: string; faq: string; support: string } };
  langSwitcher: { es: string; en: string; aria: string };
}

const ES_AR: LandingDict = {
  nav: {
    howItWorks: "Cómo funciona",
    faq: "FAQ",
    support: "Soporte",
    getStarted: "Empezar gratis",
  },
  rolePicker: {
    groupLabel: "¿Cómo querés entrar?",
    ownerLabel: "Soy dueño",
    ownerSub: "Entrar con Google",
    ownerAriaLabel: "Entrar como dueño con Google",
    staffLabel: "Soy staff",
    staffSub: "Ingresá con tu código",
    staffAriaLabel: "Entrar como empleado con código de negocio",
    staffFormLabel: "Ingresar como empleado",
    codeLabel: "Código de tu negocio",
    codePlaceholder: "Pegá el código de tu negocio",
    submitLabel: "Entrar",
    submitLoading: "Validando…",
    noCodeHelp: "¿Primera vez? Pedile el link a tu dueño — la próxima entrás directo.",
    backLabel: "Volver",
    backAriaLabel: "Volver al selector de rol",
    invalidCode: "Código inválido. Pedí el código a tu dueño.",
  },
  hero: {
    tagline: "Comercio agéntico, de punta a punta",
    eyebrow: "Beta abierta · comercio agéntico",
    headline: "El comercio que se ejecuta",
    headlineEm: "entre agentes",
    lede: "Un cliente escribe por WhatsApp — un agente de IA vende, cobra con MercadoPago, factura contra ARCA y despacha con Andreani. De punta a punta, sin intervención humana. Y Claude, ChatGPT o Gemini operan tu negocio vía el estándar abierto MCP.",
    ctaPrimary: "Empezar gratis con Google",
    ctaWhatsApp: "Ver una demo por WhatsApp",
    ctaMeta: "2 min · sin tarjeta",
    ctaPrivacy: "🔒 Tus datos son privados · Privacidad",
    voiceMockup: {
      cashierLine1: "algún pedido nuevo?",
      cashierLine1Meta: "14:32 · vos",
      assistantLine1: "Sí — 2 ventas cerradas solas · ",
      assistantLine1Sub: "Cobradas y despachadas",
      cashierLine2: "cuánto entró hoy?",
      cashierLine2Meta: "14:33 · vos",
      assistantLine2Pre: "Hoy llevás ",
      assistantLine2Highlight: "$42.300",
      assistantLine2Post: " en 8 ventas.",
      assistantLine2Sub: "Tus agentes las cerraron",
      micLabel: "Hablale. Tus agentes hacen el resto.",
    },
  },
  connecting: "Conectando…",
  trust: [
    "Tu agente vende, cobra y despacha solo",
    "Cualquier IA lo opera vía MCP",
    "Estándares abiertos — MCP + A2A",
    "Gratis para siempre en beta",
  ],
  how: {
    label: "Simple desde el día uno",
    h2: "Cómo trabaja Velora",
    sub: "Vos dirigís, tus agentes ejecutan. Sin capacitación ni manuales.",
    steps: [
      { title: "El agente vende y cobra", body: "Un cliente escribe por WhatsApp y tu agente le muestra el catálogo, arma el pedido y cobra con MercadoPago — solo." },
      { title: "El agente factura y despacha", body: "Emite comprobantes contra ARCA y coordina el envío con Andreani. De punta a punta, sin que toques nada." },
      { title: "Cualquier agente lo opera", body: "Claude, ChatGPT y Gemini se conectan vía el estándar abierto MCP. Cualquier motor de IA puede operar tu negocio." },
    ],
  },
  features: {
    label: "Una red de agentes",
    h2: "Tus agentes hacen el trabajo. Vos decidís.",
    sub: "Velora coordina ventas, pagos, envíos y facturación agente-a-agente — con tus clientes y con los sistemas de afuera. Todo desde una conversación.",
    cards: [
      { title: "Ventas que se cierran solas", body: "Tu agente atiende al cliente, arma el pedido y lo cobra. Vos te enterás cuando ya está vendido." },
      { title: "Pagos coordinados", body: "Genera el link de Mercado Pago, confirma la cobranza y deja la venta lista — sin que toques nada." },
      { title: "Envíos agente-a-agente", body: "Cotiza con el correo, despacha y te trae el seguimiento. Tu agente habla con el del correo, no vos." },
      { title: "Facturación automática", body: "Emite comprobantes contra ARCA y se los manda al cliente por WhatsApp. Sin vueltas." },
      { title: "Stock y caja al día", body: "Cada venta actualiza el stock y la caja sola. Te avisa cuando algo se está por acabar." },
    ],
    visuals: { cash: { today: "Hoy", vsYesterday: "vs ayer" } },
  },
  faq: {
    label: "Preguntas frecuentes",
    h2: "Lo que nos preguntan siempre",
    items: [
      { q: "¿Es gratis?", a: "Sí, completamente gratis durante la beta. Cuando lancemos planes pagos, el básico seguirá siendo gratuito." },
      { q: "¿Mis datos de voz son privados?", a: "Tu voz nunca se guarda. El audio se convierte a texto al instante y solo ese texto se procesa. Tus ventas y stock son privados y solo los ves vos." },
      { q: "¿Necesito instalar algo?", a: "No. Funciona desde el navegador de tu celular. Sin apps, sin descargas. Chrome o Safari en Android o iPhone." },
      { q: "¿Para qué tipo de negocio sirve?", a: "Cualquier negocio que venda productos: comercios, distribuidoras, puntos de venta, franquicias. Si vendés y despachás, tu agente puede atender al cliente, cobrar y coordinar el envío solo." },
      { q: "¿Funciona sin internet?", a: "El reconocimiento de voz necesita conexión. Si escribís en vez de hablar, el historial y los datos del negocio quedan disponibles offline." },
      { q: "¿Qué pasa si Velora no me entiende?", a: "Podés escribir lo que querías decir. Todo lo que se puede decir también se puede tipear." },
      { q: "¿Puedo usarlo desde el celular?", a: "Sí, está hecho para celular. Funciona en Chrome y Safari desde cualquier dispositivo, sin instalar nada." },
      { q: "¿Qué pasa cuando termine la beta?", a: "El plan básico sigue gratis para siempre. Cuando lancemos planes pagos, los anunciamos con 60 días de aviso. Si no querés pagar, te quedás con el plan gratuito." },
      { q: "¿Puedo exportar mis datos si me voy?", a: "Sí. Tus datos son tuyos y podés pedirlos en cualquier momento. Tu información nunca queda rehén." },
      { q: "¿Qué pasa con mi info si dejo de usar Velora?", a: "Si cerrás tu cuenta, borramos todos tus datos en 30 días. Si dejás de entrar pero no cerrás la cuenta, tus datos quedan tal cual los dejaste." },
    ],
  },
  cta: {
    h2: "Probalo dos minutos. Si no te sirve, lo dejás.",
    sub: "Sin contrato, sin tarjeta, sin instalación. Cancelás cerrando la pestaña.",
    button: "Empezar gratis con Google",
    small: "Gratis · sin tarjeta · 2 minutos",
  },
  stickyCta: {
    title: "Empezá gratis hoy",
    sub: "Sin tarjeta · 2 minutos",
    button: "Empezar",
  },
  footer: {
    copy: "© 2026 Velora · Hecho en Argentina 🇦🇷",
    links: { privacy: "Privacidad", how: "Cómo funciona", faq: "FAQ", support: "Soporte" },
  },
  langSwitcher: { es: "Español", en: "English", aria: "Cambiar idioma" },
};

const EN: LandingDict = {
  nav: {
    howItWorks: "How it works",
    faq: "FAQ",
    support: "Support",
    getStarted: "Start free",
  },
  rolePicker: {
    groupLabel: "How do you want to sign in?",
    ownerLabel: "I am the owner",
    ownerSub: "Sign in with Google",
    ownerAriaLabel: "Sign in as owner with Google",
    staffLabel: "I am staff",
    staffSub: "Enter with your business code",
    staffAriaLabel: "Sign in as employee with business code",
    staffFormLabel: "Employee sign in",
    codeLabel: "Your business code",
    codePlaceholder: "Paste your business code",
    submitLabel: "Enter",
    submitLoading: "Validating…",
    noCodeHelp: "First time? Ask your owner for the link — next time you skip this step.",
    backLabel: "Back",
    backAriaLabel: "Back to role selector",
    invalidCode: "Invalid code. Ask your owner for the correct code.",
  },
  hero: {
    tagline: "Agentic Commerce, end-to-end",
    eyebrow: "Open beta · agentic commerce",
    headline: "Commerce that runs",
    headlineEm: "end to end",
    lede: "A customer messages on WhatsApp — an AI agent sells, charges via MercadoPago, invoices via ARCA, and ships via Andreani. End to end, zero human intervention. And Claude, ChatGPT, or Gemini can operate your business via the open MCP standard.",
    ctaPrimary: "Start free with Google",
    ctaWhatsApp: "See a demo on WhatsApp",
    ctaMeta: "2 min · no card",
    ctaPrivacy: "🔒 Your data is private · Privacy",
    voiceMockup: {
      cashierLine1: "any new orders?",
      cashierLine1Meta: "2:32 PM · you",
      assistantLine1: "Yes — 2 sales closed on their own · ",
      assistantLine1Sub: "Charged and shipped",
      cashierLine2: "how much came in today?",
      cashierLine2Meta: "2:33 PM · you",
      assistantLine2Pre: "Today you're at ",
      assistantLine2Highlight: "$42,300",
      assistantLine2Post: " across 8 sales.",
      assistantLine2Sub: "Your agents closed them",
      micLabel: "Just talk to it. Your agents do the rest.",
    },
  },
  connecting: "Connecting…",
  trust: ["Agent sells, charges and ships on its own", "Any AI operates it via MCP", "Open standards — MCP + A2A", "Free forever in beta"],
  how: {
    label: "Simple from day one",
    h2: "How Velora works",
    sub: "You direct, your agents execute. No training, no manuals.",
    steps: [
      { title: "Agent sells and charges", body: "A customer messages on WhatsApp and your agent shows the catalog, builds the order, and charges via MercadoPago — on its own." },
      { title: "Agent invoices and ships", body: "It issues official receipts via ARCA and arranges shipping via Andreani. End to end, without you touching anything." },
      { title: "Any AI agent can operate it", body: "Claude, ChatGPT, and Gemini connect via the open MCP standard. Any AI engine can run your business." },
    ],
  },
  features: {
    label: "A network of agents",
    h2: "Your agents do the work. You decide.",
    sub: "Velora coordinates sales, payments, shipping, and invoicing agent-to-agent — with your customers and the outside systems. All from a conversation.",
    cards: [
      { title: "Sales that close themselves", body: "Your agent serves the customer, builds the order, and charges it. You find out once it's sold." },
      { title: "Coordinated payments", body: "It generates the payment link, confirms the charge, and posts the sale — without you touching it." },
      { title: "Agent-to-agent shipping", body: "It quotes with the courier, dispatches, and brings back tracking. Your agent talks to the courier's, not you." },
      { title: "Automatic invoicing", body: "It issues official receipts and sends them to the customer on WhatsApp. No fuss." },
      { title: "Live stock and cash", body: "Every sale updates stock and the till on its own. It warns you when something runs low." },
    ],
    visuals: { cash: { today: "Today", vsYesterday: "vs yesterday" } },
  },
  faq: {
    label: "Frequently asked",
    h2: "Things people ask",
    items: [
      { q: "Is it free?", a: "Yes, completely free during the beta. When paid plans launch, the basic tier stays free." },
      { q: "Is my voice data private?", a: "Your voice is never stored. Audio is converted to text instantly, and only the text is processed. Your sales and stock are private — only you see them." },
      { q: "Do I have to install anything?", a: "No. It runs from your phone's browser. No apps, no downloads. Chrome or Safari on Android or iPhone." },
      { q: "What kinds of business does it work for?", a: "Any business that sells products: shops, distributors, points of sale, franchises. If you sell and ship, your agent can serve the customer, charge, and coordinate delivery on its own." },
      { q: "Does it work offline?", a: "Voice recognition needs a connection. If you type instead of speak, your business data and history stay available offline." },
      { q: "What if Velora doesn't understand me?", a: "You can type what you meant to say. Anything that can be spoken can also be typed." },
      { q: "Can I use it on my phone?", a: "Yes, it's built for phones. Works in Chrome and Safari on any device, no install required." },
      { q: "What happens when the beta ends?", a: "The basic plan stays free forever. When paid plans launch, we announce with 60 days notice. If you don't want to pay, you keep the free plan." },
      { q: "Can I export my data if I leave?", a: "Yes. Your data is yours and you can request it anytime. Your information is never held hostage." },
      { q: "What happens to my data if I stop using Velora?", a: "If you close your account, we delete your data within 30 days. If you stop logging in but don't close the account, your data stays as you left it." },
    ],
  },
  cta: {
    h2: "Try it for two minutes. If it doesn't work, just leave.",
    sub: "No contract, no card, no install. Cancel by closing the tab.",
    button: "Start free with Google",
    small: "Free · no card · 2 minutes",
  },
  stickyCta: {
    title: "Start free today",
    sub: "No card · 2 minutes",
    button: "Start",
  },
  footer: {
    copy: "© 2026 Velora · Built in Argentina 🇦🇷",
    links: { privacy: "Privacy", how: "How it works", faq: "FAQ", support: "Support" },
  },
  langSwitcher: { es: "Español", en: "English", aria: "Switch language" },
};

export const DICTIONARIES: Record<Locale, LandingDict> = {
  "es-AR": ES_AR,
  en: EN,
};

export function getDict(locale: Locale): LandingDict {
  return DICTIONARIES[locale];
}
