/* English copy — US enterprise / B2B / investor register. Native copy, NOT a
   translation of the Spanish. Hero stays an emotional hook; the body is technical. */
import type { LandingCopy } from "./landing-copy";

export const defaultCopyEn: LandingCopy = {
  header: {
    wordmark: "Velora",
    nav: [
      { label: "How it works", href: "#como-funciona" },
      { label: "Where to use it", href: "#superficies" },
      { label: "Integrations", href: "#integraciones" },
      { label: "FAQ", href: "#preguntas" },
    ],
    switcher: { es: "ES", en: "EN", aria: "Switch language" },
    cta: "Start free",
  },
  hero: {
    eyebrow: "We build MCP products with real UI — this is our flagship",
    wordmark: "VELORA",
    verb: "Sell without being there.",
    tagline:
      "Run your business with AI. Sales, stock, payments — all from the chat. Your AI agent team works while you direct.",
    taglineStrong: "From your Claude, ChatGPT or Gemini — or the Velora App.",
    ctaLabel: "Start free with Google",
    ctaMicroTrust: "Free in beta · no card",
    imageAlt: "Velora in use: the owner asks about a product and sees the catalog in the chat",
    visualPlaceholderCaption: 'Real capture of the “let’s see my business” widget — coming soon',
  },
  benefits: {
    label: "Capabilities",
    headline: "From first message to delivery, on its own.",
    items: [
      {
        title: "Sell and charge",
        body: "The agent handles WhatsApp, builds the order, generates the payment link and confirms collection — without you being there.",
      },
      {
        title: "Invoice and ship",
        body: "Issues the tax invoice and coordinates shipping with the carrier — agent to agent, no forms.",
      },
      {
        title: "Operated from any AI",
        body: "Use your Claude, ChatGPT or Gemini. Same business, run from the AI you already use — or go straight in through the Velora App.",
      },
    ],
  },
  steps: {
    items: [
      { n: "01", verb: "An order comes in on WhatsApp" },
      { n: "02", verb: "The agent sells and charges" },
      { n: "03", verb: "It invoices and ships on its own" },
    ],
  },
  quiet: {
    items: [
      "Built on open standards — MCP + A2A.",
      "Interoperable with Claude, ChatGPT and Gemini.",
      "Cryptographic identity and traceability per agent.",
    ],
  },
  surfaces: {
    label: "Where to use it",
    headline: "Use Velora where you already work.",
    sub: "Three entry points, the same business. Pick the one that fits how you operate today — without losing anything. Gemini already operates Velora directly via MCP — see Integrations.",
    entries: [
      {
        name: "ChatGPT",
        description:
          "Velora as a toolkit inside ChatGPT. Check catalog, log sales, and track stock without leaving the conversation. Connected via the open MCP standard.",
        badge: "Available via MCP · directory listing soon",
        available: false,
      },
      {
        name: "Claude / Cowork",
        description:
          "Operate Velora from Claude. Ideal if you already use Cowork day-to-day: the same chat manages your business and your work tools. Connected via MCP.",
        badge: "Available via MCP · directory listing soon",
        available: false,
      },
      {
        name: "Velora App",
        description:
          "The native Velora app. Sign in with Google, configure your business in chat, and start operating in minutes. Built on Google infrastructure with cryptographic agent identity.",
        badge: "Available now",
        available: true,
        ctaLabel: "Start with Google",
        ctaHref: "#",
      },
    ],
  },
  widgets: {
    label: "Experience",
    headline: "Not plain text. Graphical widgets.",
    sub: "Velora doesn't dump raw data into the chat. At every critical step, an interactive widget appears — review, confirm, and track status in real time.",
    steps: [
      {
        n: "01",
        title: "Payment wizard",
        body: "When it's time to charge, Velora displays a wizard with the order details, amount and method. You confirm — the agent executes.",
      },
      {
        n: "02",
        title: "Live payment status",
        body: "A status widget shows whether payment is pending, processing or confirmed. No refreshing, no asking the customer.",
      },
      {
        n: "03",
        title: "Receipt delivered",
        body: "Payment confirmed. Velora generates the receipt and sends it via WhatsApp — the customer receives it before you close the chat.",
      },
    ],
  },
  integraciones: {
    title: "Integrations",
    headline: "Velora lives inside your AI.",
    sub: "Claude, ChatGPT or Gemini operate Velora through the open MCP standard. The same business, run from any AI. Screenshots are from the live product running in Argentina (Spanish-language UI).",
    endpoint: "Connect your agent to tools.somosvelora.com/api/mcp",
    cards: [
      {
        name: "Claude",
        imageAlt:
          "Claude selling in Velora: finds the customer, checks stock and generates the MercadoPago payment link",
        caption: "Sell and get paid: customer, stock and payment link in one message.",
        imageSrc: "/integraciones/claude-3-vender.jpg",
        hasScreenshot: true,
      },
      {
        name: "ChatGPT",
        imageAlt:
          "ChatGPT querying Velora's catalog: product list with price and stock",
        caption: "Check your whole catalog and stock in an instant.",
        imageSrc: "/integraciones/chatgpt-catalogo.jpg",
        hasScreenshot: true,
      },
      {
        name: "Gemini",
        imageAlt:
          "Live Gemini CLI session querying the Velora catalog via MCP: Gemini calls mcp_velora_query_catalog and returns real product stock data",
        caption: "Gemini operates Velora via MCP — live.",
        imageSrc: "/integraciones/gemini-cli-velora.jpg",
        hasScreenshot: true,
      },
    ],
  },
  faq: {
    title: ["Things people ", "actually", " want to know."],
    subtitle: "Missing something? Write to gestiones@somosvelora.com.",
    items: [
      {
        q: "What is Velora?",
        a: "We build MCP products with real UI — Velora is our flagship: an agentic commerce platform where AI agents sell, charge, invoice and ship end to end, interoperate agent-to-agent, and are operated from your Claude, ChatGPT or Gemini — or from the Velora App.",
      },
      {
        q: "Where can I use Velora?",
        a: "From your Claude or ChatGPT, via the open MCP standard — connect them today with the public endpoint; official directory listings are on the way. Gemini also connects today, directly and with no directory needed (see Integrations). You can also go straight in through the Velora App (available now, sign in with Google). Same business from whichever you use.",
      },
      {
        q: "Are the chat widgets real?",
        a: "Yes. When Velora needs you to confirm a charge, it shows a widget with the details — not just text. Payment status updates in the same chat without you having to ask.",
      },
      {
        q: "Is it secure?",
        a: "Yes. Velora runs on Google Vertex AI with the A2A protocol, cryptographic agent identity, and full auditability of every action taken on your behalf.",
      },
      {
        q: "What if the agent makes a mistake?",
        a: "You're in control. Every action is logged and you can review or undo it from the chat. Nothing happens behind your back.",
      },
      {
        q: "Do I need to know technology?",
        a: "No. If you can send a voice note or a WhatsApp message, you can operate Velora.",
      },
      {
        q: "How much does it cost?",
        a: "Still being decided. The private beta is free for as long as it lasts. Write to us to coordinate early access.",
      },
      {
        q: "How do I connect my providers?",
        a: "Velora speaks A2A with Andreani, MercadoPago, ARCA, and other enterprise agents. If your provider doesn't expose an agent yet, we can connect via API in hours.",
      },
    ],
  },
  closing: {
    headline: "Run your business with AI, from anywhere.",
    ctaLabel: "Start free with Google",
    microTrust: "Free in beta · no card",
  },
  footer: {
    copyright: "© 2026 Velora",
    links: [
      { label: "Privacy", href: "/privacy" },
      { label: "Terms", href: "/terms" },
      { label: "Developers", href: "/developers" },
    ],
    contactEmail: "gestiones@somosvelora.com",
  },
};
