// Language-aware wrapper around SUPERVISOR_PROMPT. The base prompt stays in
// Spanish because every few-shot, AR slang decoder and parsing rule is tuned
// for rioplatense input — switching the base would force a costly rewrite
// of the entire instruction set with zero accuracy gain. The directive
// appended here only governs the OUTPUT language of conversational fields
// ("answer", "clarification.question", chip labels, onboarding greetings).
//
// Mirrors the Companion/Employee LANGUAGE_LOCK_EN pattern in
// business-assistant/_lib/model.ts so both halves of the chat respect the
// same Settings toggle (writes localStorage `velora-lang` + cookie
// `NEXT_LOCALE`, threaded server-side via SupervisorCallContext.lang).

import { SUPERVISOR_PROMPT } from "./supervisor-prompt";

// Instrucción inyectada cuando el Supervisor corre sobre ADK con herramientas
// de delegación registradas. Le dice al LLM que llame las tools DIRECTAMENTE
// (no que emita intents en actions[]) y que espere el resultado antes de
// responder al dueño.
// call_marketplace_agent is SHELVED (2026-05-25) — removed from this block.
// It is NOT registered in supervisor-agent.ts toolContext, so the Pro model would
// waste the full 25s ADK timeout attempting to call a non-existent tool. Re-add
// here only when the ML agent is un-shelved and the tool is re-registered.
//
// call_ventas_agent is excluded when USE_OWNER_ASSISTANT=true: the Owner Assistant
// intercepts all ventas/cobros mutations upstream, so the tool is not registered
// in the ADK runner (supervisor-runner.ts). Declaring a tool the model cannot
// actually invoke confuses the model. Principle: only declare tools you provide.
// Ref: https://ai.google.dev/gemini-api/docs/function-calling
function buildToolsActiveBlock(ownerAssistantActive: boolean): string {
  const ventasLine = ownerAssistantActive
    ? ""
    : "\n- call_ventas_agent: Agente de Ventas/Cobros — generar un cobro QR o link de pago para un cliente (Mercado Pago). Aceptá el parámetro opcional clientPhone si tenés el teléfono del cliente.";
  // ownerAssistantActive=true  → contador + logistica + communications + customer = 4
  // ownerAssistantActive=false → contador + ventas + logistica + communications + customer = 5
  const toolCount = ownerAssistantActive ? "cuatro" : "cinco";
  return `

HERRAMIENTAS DE DELEGACIÓN ACTIVAS:
Tenés disponibles ${toolCount} agentes de rol que representan posiciones clave de una empresa:
- call_contador_agent: Agente Contador — emisión de facturas/comprobantes, situación impositiva, cumplimiento fiscal (ARCA/AFIP).${ventasLine}
- call_logistica_agent: Agente de Logística — cotizar, crear o rastrear envíos (Andreani). Requerís el skill (shipment.quote | shipment.create | shipment.track) y los params del skill.
- call_communications_agent: Agente de Comunicaciones — enviar notificaciones push (VAPID/FCM) al dueño o a un empleado, o escribir un mensaje al chat del dueño. NO para WhatsApp — ese canal es independiente.
- call_customer_agent: Agente de Clientes WhatsApp — gestionar conversaciones B2C con clientes vía WhatsApp (consultas, checkout, seguimiento de pedidos). SOLO para conversaciones B2C con el cliente final por WhatsApp — NO para notificaciones al dueño ni al equipo interno; para eso usá call_communications_agent.
REGLA CRÍTICA: cuando necesites cobrar, consultar al contador, gestionar un envío, enviar una notificación push o atender a un cliente por WhatsApp, INVOCÁ la herramienta directamente — NO emitas los nombres de las herramientas como items en el array "actions[]". El runner inyecta el resultado de la herramienta en el contexto antes de que respondas; usá ese resultado para formular tu respuesta final con la información real (link de pago, número de comprobante, cotización de envío, confirmación de notificación, etc.). Si la herramienta devuelve un error, reportalo en el campo "answer" de forma clara y accionable para el dueño.`;
}

const LANGUAGE_DIRECTIVE_ES = `

IDIOMA DE RESPUESTA:
Respondé SIEMPRE en español rioplatense (castellano de Argentina). Tono formal con vos/tenés. Sin emojis. Sin jerga callejera. Esto aplica al campo "answer", a "clarification.question", a las etiquetas de chips y a los textos del onboarding.`;

const LANGUAGE_DIRECTIVE_EN = `

RESPONSE LANGUAGE:
ALWAYS respond in English. Use natural, professional English with a calm, data-first tone. No emojis. No filler. This applies to the "answer" field, "clarification.question", chip labels and onboarding texts. Translate the few-shot Spanish examples on the fly when emitting your response — keep product names and proper nouns as the owner spelled them. Onboarding greetings in English:
- Turn 1: "Hi, I'm your Velora supervisor. I'll help you get set up in under 3 minutes. What's your business name?"
- Turn 2: "Got it, [name]. What do you sell? Tap an option or tell me in one sentence." (chips: "Apparel/boutique", "Mini-market", "Pet shop", "Beauty", "Other")
- Turn 3: "How do you get paid? Tap the ones you use and hit Done." (chips: "Cash", "Card", "Transfer", "Other")
- Turn 4: "How much cash are you starting the register with today? Just the amount (e.g., 20000)."
- Turn 5: "Let's load your first product. How would you like to do it?" (chips: "Photo of notebook", "Paste a list", "Type it in")
- Turn 6: "All set, you can start selling. Now load your top 5 products — snap the notebook or dictate them. Once you have them, we'll do your first test sale."
- Post-T6 push primer: "First sale is in. Want me to ping you when something needs your attention?" (chips: "Yes, ping me", "Later")`;

export function buildSupervisorPrompt(
  lang: "en" | "es-AR" = "es-AR",
  adkEnabled = false,
  originPostalCode: string | null = null,
): string {
  const directive = lang === "en" ? LANGUAGE_DIRECTIVE_EN : LANGUAGE_DIRECTIVE_ES;
  // Re-evaluated per call (not module-load) so the flag change takes effect
  // without a server restart — consistent with every other feature flag in Velora.
  const ownerAssistantActive = process.env.USE_OWNER_ASSISTANT === "true";
  const toolsBlock = adkEnabled ? buildToolsActiveBlock(ownerAssistantActive) : "";
  const base = `${SUPERVISOR_PROMPT}${directive}${toolsBlock}`;
  // Replace the "[origen]" placeholder in the few-shot examples with the
  // real business postal code so the LLM never emits the literal string.
  // Falls back to "0000" (safe sentinel that Andreani/mock will reject with
  // a descriptive error) when the business hasn't configured a postal code yet.
  const cp = originPostalCode ?? "0000";
  return base.replaceAll('"[origen]"', `"${cp}"`);
}
