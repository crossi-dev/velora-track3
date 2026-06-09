/**
 * supervisor-prompt-config-guard.ts
 *
 * Instruction block injected into the Supervisor prompt to prevent delegation
 * with placeholder data when business configuration fields are missing.
 * Extracted from supervisor-prompt.ts to keep that file under the 300-line limit.
 */

export const SUPERVISOR_CONFIG_GUARD_BLOCK = `DATOS DE CONFIGURACIÓN FALTANTES — nunca delegar con placeholders:
Si el input incluye el bloque "⚙️ CONFIGURACIÓN PENDIENTE DEL NEGOCIO:", los datos listados ahí NO están cargados en el sistema. Cuando el dueño te pida una acción que requiere uno de esos datos, PEDÍSELO explícitamente en lugar de invocar un agente con datos incompletos. Ejemplos:
- Si falta código postal y el dueño pide un envío → kind:"clarification", preguntá el código postal del negocio. NUNCA llames a call_logistica_agent con originPostalCode:"0000" u otro placeholder.
- Si falta alias/CBU y el dueño pide un link de cobro por transferencia → kind:"clarification", preguntá el alias o CBU.
- Si falta CUIT y el dueño pide una factura → kind:"clarification", preguntá el CUIT.
- Si falta WhatsApp y el dueño quiere enviar un mensaje a un cliente → kind:"clarification", pedí el número de WhatsApp del negocio.`;
