// Fiscal ADK agent factory — extracted from handle-fiscal-rpc.ts.
// System prompt + tools + agent construction live here.
// The RPC handler (handle-fiscal-rpc.ts) keeps dispatch + InMemoryRunner wiring.

import type { Agent } from "@google/adk";
import { FunctionTool } from "@google/adk";
import { Type } from "@google/genai";
import type { Schema } from "@google/genai";
import { createAdkAgent } from "@/lib/adk/agent-factory";
import { parseCuit, describePersonType } from "@/lib/cuit";
import { getAdkFiscalModel } from "@/lib/adk/gemini-config";
import { buildEmitInvoiceTool, type EmitInvoiceToolContext } from "./emit-invoice-tool";

// ── Business fiscal profile (F-1) ─────────────────────────────────────────────

/** Fiscal profile of the business — loaded from DB and injected into the system prompt. */
export interface BusinessFiscalProfile {
  cuit: string | null;
  ivaCondition: string | null;
  puntoVenta: string | null;
  /** True only when all ARCA setup steps are complete. Controls Estado ARCA label. */
  arcaReady: boolean;
}

function buildFiscalProfileSection(profile: BusinessFiscalProfile): string {
  const arcaEstado = profile.arcaReady
    ? "Con credencial (modo real disponible)"
    : "Sin credencial (sandbox — comprobantes sin validez fiscal real)";

  const ivaLine = profile.ivaCondition
    ? `- Condición IVA: ${profile.ivaCondition}`
    : "- Condición IVA: no registrada";

  // Hard constraint for Monotributistas — make it explicit so the LLM cannot ignore it.
  const monotributoWarning =
    profile.ivaCondition?.toLowerCase().startsWith("monotrib")
      ? "\n⚠ RESTRICCIÓN: Este negocio es Monotributista. Solo puede emitir Factura C. " +
        "NUNCA emitir Factura A ni B para este negocio, sin excepción."
      : "";

  return (
    `PERFIL FISCAL DEL NEGOCIO:\n` +
    `- CUIT: ${profile.cuit ?? "no registrado"}\n` +
    ivaLine + "\n" +
    `- Punto de venta: ${profile.puntoVenta ?? "no registrado"}\n` +
    `- Estado ARCA: ${arcaEstado}` +
    monotributoWarning
  );
}

// ── System prompt ────────────────────────────────────────────────────────────

export const FISCAL_SYSTEM_PROMPT_BASE = `Sos el Fiscal Agent de Velora — sub-agente especializado en cumplimiento tributario argentino (ARCA, ex-AFIP).

ROL Y CONTEXTO:
- Operás como sub-agente del Supervisor de Velora o en respuesta directa a owners vía protocolo A2A v0.3.0.
- Tu trabajo: validar CUIT/CUIL de clientes y emitir facturas electrónicas.
- Tono: rioplatense formal (vos/tenés), directo, datos-primero. Sin emojis. Sin relleno.

HERRAMIENTAS:
- validate_cuit: validar CUIT/CUIL con algoritmo de dígito verificador AFIP.
- emit_invoice: emitir factura electrónica ARCA.

REGLAS DE OPERACIÓN:
1. Si el input contiene algo parecido a un CUIT o CUIL → llamá validate_cuit primero.
2. Si el input pide emitir factura y ya hay un CUIT mencionado → llamá emit_invoice.
3. Nunca inventés datos fiscales. Si el CUIT es inválido, decilo con el error exacto.
4. Si faltan datos para emitir una factura → pedí los que faltan en UNA pregunta.
5. Respondé siempre con el resultado de la herramienta, no con suposiciones.
6. Formato de respuesta: una oración de resultado + datos clave. Nada más.
7. Si emit_invoice devuelve setupGuidance, transcribilo al owner exactamente — no lo reescribas.

EJEMPLOS (few-shot):

# Ejemplo 1 — Validación de CUIT exitosa
Input: "Validá el CUIT 20-12345678-9 del cliente Juan Pérez"
Acción: llamar validate_cuit con cuit="20-12345678-9"
Respuesta: "CUIT válido. 20-12345678-9 — Persona física. Tipo: Contribuyente."

# Ejemplo 2 — Emisión de factura en sandbox
Input: "Emití una factura C por $15.000 para el CUIT 20-30456789-1, concepto mercadería"
Acción: llamar emit_invoice con customerCuit="20304567891", amountARS=15000, tipo="C", concept="Mercadería"
Respuesta: "Comprobante emitido en SANDBOX (sin validez fiscal real). Factura C N°1 — CAE 20304567891234 — Vence 20260529 — $15.000."

# Ejemplo 3 — Corrección de tipo para Monotributista
Input del Supervisor: "Emití Factura A por $50.000 para CUIT 27-31234567-8"
Contexto: negocio Monotributista (según perfil fiscal inyectado)
Acción: llamar emit_invoice con tipo="A" (el agente recibirá tipo="C" en el resultado porque el sistema lo corrige)
Respuesta: "El negocio es Monotributista y solo puede emitir Factura C — la solicitud de tipo A fue corregida automáticamente. Comprobante emitido en SANDBOX. Factura C N°1 — CAE … — Vence … — $50.000."`;

/** Builds the full system instruction, optionally prepending the business fiscal profile. */
function buildSystemInstruction(profile: BusinessFiscalProfile | null): string {
  if (!profile) return FISCAL_SYSTEM_PROMPT_BASE;
  return buildFiscalProfileSection(profile) + "\n\n" + FISCAL_SYSTEM_PROMPT_BASE;
}

// ── ADK FunctionTools ────────────────────────────────────────────────────────

// Schema contract (2026-05-26 — Audit 1 finding):
//   Zod v3 emits `additionalProperties: false` on all objects and
//   `exclusiveMinimum: true` (Draft 4 boolean form), both silently rejected by
//   Vertex AI's Schema validator → empty function declaration list → Gemini
//   returns no tool call → drainEvents yields zero events → fallback fires.
//   Fix: raw `Schema` from `@google/genai` (Type enum), identical to the fix
//   applied to Payments `register_promesa_sale` tool (2026-05-26).
//   ADK FunctionTool accepts Schema | ZodObject | undefined — see
//   node_modules/@google/adk/dist/types/tools/function_tool.d.ts line 14.
const validateCuitParams: Schema = {
  type: Type.OBJECT,
  properties: {
    cuit: {
      type: Type.STRING,
      description:
        "The CUIT/CUIL to validate — accepts formatted (20-12345678-9) or raw (20123456789)",
    },
  },
  required: ["cuit"],
};

// Runtime input type — mirrors the Schema above.
type ValidateCuitInput = {
  cuit: string;
};

const validateCuitTool = new FunctionTool({
  name: "validate_cuit",
  description:
    "Validates an Argentine CUIT or CUIL identifier using the AFIP check-digit algorithm. " +
    "Returns validity, formatted ID, person type, and any error message.",
  parameters: validateCuitParams,
  execute: async (input) => {
    const { cuit } = input as ValidateCuitInput;
    const result = parseCuit(cuit);
    const personTypeDescription = describePersonType(result.personType);
    return {
      valid: result.valid,
      formatted: result.formatted,
      normalized: result.normalized,
      personType: result.personType,
      personTypeDescription,
      error: result.error ?? null,
    };
  },
});

// ── ADK agent factory (one per request — stateless) ──────────────────────────

export function createFiscalAgent(
  ctx: { businessId: string | null },
  profile: BusinessFiscalProfile | null,
  toolCtx: EmitInvoiceToolContext,
): Agent {
  // Rebuilt on agent-factory.ts (2026-05-25) — instruction-as-callback rule enforced.
  return createAdkAgent({
    name: "velora_fiscal_agent",
    model: getAdkFiscalModel(),
    instruction: buildSystemInstruction(profile),
    tools: [validateCuitTool, buildEmitInvoiceTool(ctx, toolCtx)],
  });
}
