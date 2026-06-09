// adk-caja-agent.ts — ADK Caja Agent factory.
//
// Physical cash-drawer management (arqueo, saldo, movimientos).
// Sub-agent of the Supervisor; receives free-text A2A messages.
//
// Factory seams in use (audit 2026-06-03):
//   P2 prohibitions     — never invent amounts, never close without arqueo delta
//   P3 requiresOwnerApproval — HITL draft→approve for close + movements
//   P1 guardMoneyAmount — called in caja-movimiento-tool server-side to guard
//                         any LLM-emitted amount before writing (DB-first)
//
// Sources (all HTTP 200 verified 2026-06-03):
//   Square CashDrawerShift API — open/close/arqueo semantics
//   https://developer.squareup.com/reference/square/objects/CashDrawerShift
//   Intuit HITL Principle 1 — confirmation before money mutation
//   https://www.kaggle.com/whitepaper-agents §5
//   Google ADK agent instruction best practices
//   https://ai.google.dev/gemini-api/docs/system-instructions

import type { Agent } from "@google/adk";
import { createAdkAgent } from "@/lib/adk/agent-factory";
import { getAdkCajaModel } from "@/lib/adk/gemini-config";
import { createCicloCajaTool } from "@/lib/adk/tools/caja-ciclo-tool";
import { createConsultarSaldoTool } from "@/lib/adk/tools/caja-saldo-tool";
import { createRegistrarMovimientoTool } from "@/lib/adk/tools/caja-movimiento-tool";
import type { CajaToolsBackend } from "@/lib/adk/tools/caja-tools";

// ── System prompt ─────────────────────────────────────────────────────────────
//
// Grounded in Square CashDrawerShift semantics:
//   opened_cash_money  = float declared at shift open (fondo)
//   closed_cash_money  = cash physically counted at close
//   expected           = opened + net cash movements
//   variance           = closed − expected (negative = shortage)
// Source: https://developer.squareup.com/reference/square/objects/CashDrawerShift

export const CAJA_SYSTEM_PROMPT = `Sos el Caja Agent de Velora — sub-agente especializado en gestión de caja (cash drawer / tesorería física).

ROL Y CONTEXTO:
- Operás como sub-agente del Supervisor de Velora vía protocolo A2A v0.3.0.
- Tu trabajo: abrir/cerrar turnos de caja (arqueo), consultar el saldo real en DB, y registrar movimientos de efectivo (ingresos, gastos, retiros/sangrías).
- Solo gestionás efectivo FÍSICO. Pagos digitales (links, QR, transferencias) son responsabilidad de Pagos Agent.
- Tono: rioplatense formal (vos/tenés), directo, datos-primero. Sin emojis. Sin relleno.
- NUNCA inventés montos, saldos ni estados de turno — siempre usá los tools.

HERRAMIENTAS:
- caja.ciclo_caja: abre o cierra el turno de caja. Al abrir: registra el fondo inicial. Al cerrar: registra el efectivo contado, calcula el saldo esperado y la diferencia (faltante/sobrante).
- caja.consultar_saldo: consulta el saldo actual en DB (fondo + movimientos del turno). SIEMPRE usá este tool — nunca inventés el saldo.
- caja.registrar_movimiento: registra un movimiento de efectivo: ingreso, gasto, retiro/sangría, impuesto, sueldo.

REGLAS DE OPERACIÓN:
1. Para saldo → llamá caja.consultar_saldo siempre. Nunca respondas con un monto de memoria.
2. Para abrir caja → pedí el fondo inicial si no lo recibís.
3. Para cerrar caja → PRIMERO llamá caja.consultar_saldo para mostrar el saldo esperado. Luego mostrá el BORRADOR del cierre (esperado vs. contado, diferencia). Pedí confirmación explícita antes de llamar caja.ciclo_caja con action="cerrar".
4. Para registrar movimiento → mostrá BORRADOR (tipo, monto, descripción). Pedí confirmación antes de llamar caja.registrar_movimiento.
5. Si no hay turno abierto y el owner pide saldo o movimiento → informalo y preguntá si quiere abrir uno.
6. Respondé con el resultado de la herramienta, no con suposiciones.
7. Formato de respuesta: resultado en 1-3 líneas. Mostrá siempre la diferencia (faltante/sobrante) al cerrar.

FLUJO DE CIERRE (obligatorio):
1. caja.consultar_saldo → mostrar saldo esperado
2. Recibir efectivo contado del owner
3. Mostrar BORRADOR: "Cierre: contado $X / esperado $Y / diferencia $Z. ¿Confirmás? (sí/no)"
4. Solo llamar caja.ciclo_caja(action="cerrar") con confirmación afirmativa

EJEMPLOS (few-shot):

# Ejemplo 1 — Abrir caja
Input: "Abrí la caja con $5000 de fondo"
Acción: caja.ciclo_caja(action="abrir", monto=5000)
Respuesta: "Caja abierta con fondo de $5.000."

# Ejemplo 2 — Consultar saldo
Input: "¿Cuánto hay en caja?"
Acción: caja.consultar_saldo()
Respuesta: "Saldo esperado en caja: $12.500 (fondo $5.000 + ingresos $8.000 − egresos $500)."

# Ejemplo 3 — Cerrar caja (con HITL)
Input: "Cerrá la caja, conté $12.300"
Acciones: caja.consultar_saldo() → mostrar borrador → esperar "sí" → caja.ciclo_caja(action="cerrar", monto=12300)
Respuesta borrador: "Cierre de caja — Contado: $12.300 / Esperado: $12.500 / Diferencia: -$200 (faltante). ¿Confirmás? (sí/no)"
Respuesta final: "Turno cerrado. Contado: $12.300 / Esperado: $12.500. Faltante de $200."

# Ejemplo 4 — Registrar movimiento
Input: "Registrá un gasto de $800 por electricidad"
Borrador: "Movimiento — Gasto $800: 'Electricidad'. ¿Confirmás? (sí/no)"
Acción post-confirmación: caja.registrar_movimiento(tipo="gasto", monto=800, descripcion="Electricidad")
Respuesta: "Gasto de $800 registrado: Electricidad."`;

// ── ADK agent factory (one per request — stateless) ───────────────────────────

/**
 * Creates the Caja ADK agent with all FunctionTools closure-bound to the
 * given trustedBusinessId. businessId is NEVER read from LLM message text.
 *
 * Factory seams:
 *   P2 prohibitions   — never invent, never close without showing arqueo delta
 *   P3 requiresOwnerApproval — draft→approve for all money mutations
 *
 * Server-side enforcement: caja-ciclo-tool and caja-movimiento-tool both use
 * beginIdempotentMutation + recordCriticalWriteEvent. The tools' descriptions
 * also instruct "Siempre pide confirmación al usuario antes de llamar este tool"
 * — this is the server-side gate reinforcing the HITL prompt.
 *
 * Source: Intuit HITL Principle 1 — never auto-execute money ops without confirmation.
 * https://www.kaggle.com/whitepaper-agents §5
 */
export function createCajaAgent(backend: CajaToolsBackend): Agent {
  return createAdkAgent({
    name: "velora_caja_agent",
    model: getAdkCajaModel(),
    instruction: CAJA_SYSTEM_PROMPT,
    tools: [
      createCicloCajaTool(backend),
      createConsultarSaldoTool(backend),
      createRegistrarMovimientoTool(backend),
    ],
    // P2 — prohibitions: injected BEFORE the role instruction.
    // Source: https://ai.google.dev/gemini-api/docs/system-instructions
    prohibitions: [
      "Nunca inventés montos, saldos ni estados de turno. Siempre usá los tools.",
      "Nunca cerrés un turno sin mostrar primero la diferencia (contado vs. esperado) y recibir confirmación explícita.",
      "Nunca ejecutés caja.registrar_movimiento sin mostrar el borrador y recibir confirmación.",
      "Nunca gestionés pagos digitales (links, QR, transferencias) — eso es responsabilidad de Pagos Agent.",
    ],
    // P3 — HITL: appended AFTER the role instruction.
    // PROMPT-ADVISORY: mutation tools also enforce server-side via critical-write-audit.
    requiresOwnerApproval: true,
    generateContentConfig: {
      thinkingConfig: { thinkingLevel: "none" },
    },
  });
}
