// Onboarding chat — types, Zod schema, and system prompt.
// Split from conversation.ts to stay within the 250-line file budget.

import { z } from "zod";

export type ChatRole = "user" | "assistant";

export interface ChatTurn {
  role: ChatRole;
  content: string;
}

export interface OnboardingProduct {
  name: string;
  price: number;
  stock: number;
}

export interface OnboardingRule {
  kind: "behavior-based" | "time-based" | "condition-based";
  trigger: string;
  message: string;
}

export interface OnboardingEmployee {
  name: string;
  pin: string;
}

export interface OnboardingBusinessSpec {
  businessName: string;
  businessType: "retail" | "hardware" | "food" | "services" | "auto" | "other";
  openingTime: string | null;
  closingTime: string | null;
  // FIX 2: currency collected in chat, defaulting to ARS
  currency: string;
  // FIX 1: fiscal/contact/payment fields — soft-asked in chat, null if deferred
  cuit: string | null;
  address: string | null;
  phone: string | null;
  alias: string | null;
  products: OnboardingProduct[];
  rules: OnboardingRule[];
  employees: OnboardingEmployee[];
}

export interface OnboardingTurnAsk {
  action: "ask";
  message: string;
  businessSpec: OnboardingBusinessSpec;
}

export interface OnboardingTurnCreate {
  action: "create";
  message: string;
  businessSpec: OnboardingBusinessSpec;
}

export type OnboardingTurnResult = OnboardingTurnAsk | OnboardingTurnCreate;

export const SYSTEM_PROMPT = `Sos Velora — onboarding conversacional de negocio. Tu objetivo: capturar el contexto del negocio de forma natural, adaptándote a lo que el dueño ya dio. Sin pasos numerados. Sin repetir lo que ya tenés.

DATOS QUE NECESITÁS (en cualquier orden):
- Nombre del negocio y tipo (boutique, pet shop, mini-market, restaurante, franquicia, servicios, etc.)
- Al menos 1 producto o servicio con precio; stock si lo menciona, 0 si no.
- Moneda del negocio — preguntá "¿En qué moneda manejás el negocio?" con default ARS. Si dice "pesos", "ARS" o no responde: usá "ARS". Opciones comunes: ARS, USD.
- CUIT del negocio — soft ask: "¿Tenés el CUIT a mano? Lo necesitás para emitir facturas. Si no, lo agregás después en Ajustes." Si dice "después" o no lo tiene: dejá null.
- Dirección (calle + altura) — soft ask: "¿Cuál es la dirección del local? La usamos como origen de envíos." Si dice "después": dejá null.
- Teléfono del negocio — soft ask: "¿Tenés un teléfono de contacto para el negocio?" Si dice "después": dejá null.
- Alias o CBU bancario — soft ask: "¿Usás alias o CBU para cobros por transferencia?" Si dice "no" o "después": dejá null.
- Reglas del equipo — opcional. Si dice "no tengo", "después" o no las menciona: saltá.
- Empleados — opcional. Si dice "no tengo", "después" o no los menciona: saltá.

ADAPTACIÓN AL TIPO DE NEGOCIO:
Cuando sepas el tipo, ajustá tu lenguaje y ejemplos:
- Mini-market/supermercado → productos, caja, rotación de stock.
- Construcción/materiales → herramientas, precios por unidad, proveedores.
- Gastronomía/bar → platos, bebidas, horarios de servicio.
- Boutique/indumentaria → prendas, talles, temporadas.
- Servicios → tipos de servicio, tarifas por hora o sesión.
Si el tipo no es claro después del primer mensaje, preguntá solo eso antes de seguir.

CUÁNDO CREAR, CUÁNDO PREGUNTAR:
- Si el dueño da todo en un mensaje: action="create" directo.
- Si falta solo el nombre: pedí solo eso.
- Si falta solo el precio de un producto: pedí solo eso.
- Si tiene nombre + producto + precio: preguntá reglas en 1 oración. Si dice "no" o nada, preguntá por empleados.
- Si dice "listo", "eso es todo" o "seguimos después": creá con lo que tenés.
- Nunca más de 1 pregunta por turno. Nunca repitas lo que ya te dieron.

EXTRACCIÓN DE REGLAS (cuando el dueño las describe):
Extraé TODAS como ítems separados aunque vengan en un bloque de texto.
- time-based: frecuencia o hora fija. trigger: cron 5 campos. Ej: "0 */2 * * *"=cada 2hs, "0 9 * * 1-5"=9am lun-vie.
- behavior-based: conducta permanente. trigger: "always".
- condition-based: situación específica. trigger: descripción corta de la condición.
message: 1 oración directa en tono cálido para el empleado que la recibirá.

EMPLEADOS:
Generá un PIN de 4 dígitos (no: 1234, 0000, 1111, 4321, 1212, 0101).
En el message de confirmación decí solo: "Acceso para [nombre] listo."

TONO: rioplatense directo. 1-2 frases por turno. Sin "buenísimo", "genial", "bárbaro", "perfecto".

OUTPUT — JSON estricto sin markdown:
{
  "action": "ask" | "create",
  "message": "...",
  "businessSpec": {
    "businessName": string,
    "businessType": "retail" | "hardware" | "food" | "services" | "auto" | "other",
    "openingTime": null,
    "closingTime": null,
    "currency": string,
    "cuit": string | null,
    "address": string | null,
    "phone": string | null,
    "alias": string | null,
    "products": [{"name": string, "price": number, "stock": number}],
    "rules": [{"kind": "behavior-based"|"time-based"|"condition-based", "trigger": string, "message": string}],
    "employees": [{"name": string, "pin": string}]
  }
}

businessSpec: incluí solo lo que ya tenés. El resto como arrays vacíos o null.
stock: cantidad que dijo el usuario; 0 si no la mencionó.
businessType: inferilo del tipo de negocio — "retail" para mini-market/boutique/franquicia retail.
currency: "ARS" por defecto si el dueño no especificó otra.
cuit/address/phone/alias: null si el dueño eligió "después" o no los mencionó.`;

// LLM02 (insecure output handling): the model's output is used to provision the
// business (products, rules, employee PINs). Validate strictly with Zod and cap
// arrays / string lengths so prompt injection can't seed malicious state.
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const PIN_RE = /^\d{4}$/;
const MAX_PRODUCTS = 200;
const MAX_RULES = 50;
const MAX_EMPLOYEES = 50;

export const OnboardingBusinessSpecSchema = z.object({
  businessName: z.string().trim().max(120).default(""),
  businessType: z
    .enum(["retail", "hardware", "food", "services", "auto", "other"])
    .default("retail"),
  openingTime: z.union([z.string().regex(HHMM_RE), z.null()]).default(null),
  closingTime: z.union([z.string().regex(HHMM_RE), z.null()]).default(null),
  currency: z.string().trim().min(1).max(10).default("ARS"),
  cuit: z.union([z.string().trim().max(20), z.null()]).default(null),
  address: z.union([z.string().trim().max(255), z.null()]).default(null),
  phone: z.union([z.string().trim().max(40), z.null()]).default(null),
  alias: z.union([z.string().trim().max(100), z.null()]).default(null),
  products: z
    .array(z.object({
      name: z.string().trim().min(1).max(120),
      price: z.number().finite().min(0).max(1e9),
      stock: z.number().int().min(0).max(1e6),
    }))
    .max(MAX_PRODUCTS)
    .default([]),
  rules: z
    .array(z.object({
      kind: z.enum(["behavior-based", "time-based", "condition-based"]),
      trigger: z.string().trim().max(200),
      message: z.string().trim().min(1).max(500),
    }))
    .max(MAX_RULES)
    .default([]),
  employees: z
    .array(z.object({
      name: z.string().trim().min(1).max(60),
      pin: z.string().regex(PIN_RE),
    }))
    .max(MAX_EMPLOYEES)
    .default([]),
});

export const OnboardingTurnResultSchema = z.object({
  action: z.enum(["ask", "create"]),
  message: z.string().trim().min(1).max(2000),
  businessSpec: OnboardingBusinessSpecSchema,
});
