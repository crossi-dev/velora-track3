// supervisor-prompt-examples.ts — few-shot examples blocks for the Supervisor prompt.
// Extracted from supervisor-prompt.ts to keep that file under the 300-line server limit.

export const SUPERVISOR_EXAMPLES_PURCHASE_BUDGET = "";
// SUPERVISOR_EXAMPLES_PURCHASE_BUDGET migrated 2026-05-25 — purchase request
// few-shots now live in VENTAS_SYSTEM_PROMPT (Ventas Agent absorbs the intent
// via Pattern C). Presupuestos block was previously SHELVED. The string is
// kept as "" so the template literal in supervisor-prompt.ts still resolves.

// Ejemplos few-shot — Presupuestos: SHELVED 2026-05-25 — feature create_budget
// removido del supervisor prompt + del mapper. UI tab también shelved. El
// código de handlers/mapper queda intacto en supervisor-action-mapper.ts y
// los components para reactivación futura. Restaurar agregando el block here
// + re-listing create_budget en OPERATIONAL_INTENTS + CANONICAL_INTENTS.

// SUPERVISOR_EXAMPLES_A2A_STOCK: SHELVED 2026-05-25 junto con el Companion.
// El supervisor ya no escucha EMPLOYEE_EVENTs porque el Companion no emite.
// El handler STOCK_INGRESS_REQUEST sigue vivo si en el futuro se re-activa
// — el bloque original quedó preservado en git history (revertir con
// `git log -- supervisor-prompt-examples.ts` y restaurar el template literal).

// SUPERVISOR_EXAMPLES_EMPLOYEES: removed in Fase E (Equipo Agent), Equipo Agent
// then also shelved 2026-05-25 alongside Companion. Code stays in
// employee-actions.ts / broadcast-actions.ts and src/app/api/agents/equipo/ for
// reactivation. Restore by re-exposing the block and re-wiring the agent.

export const SUPERVISOR_EXAMPLES_DELEGATION = `
PERÍMETRO DE DELEGACIÓN (create_delegation_policy / update_delegation_policy / delete_delegation_policy):
El dueño define cuánta autonomía tiene el sistema para actuar sin su aprobación.
Schema create_delegation_policy.data: { "scope": "stock"|"sale"|"return", "maxValue": number|null, "requiresOwner": boolean, "conditions": string }
- scope "stock": límite financiero para aprobar ingresos de mercadería automáticamente. maxValue=0 o requiresOwner=true → escalar siempre.
- scope "sale" / "return": maxValue = monto máximo de transacción sin confirmación del dueño.
- conditions: JSON string libre para criterios adicionales (ej: '{"supplierWhitelist":["Distribuidora X"]}').
- Si la policy ya existe para ese scope, hacé update implícito (idempotente por scope).
- update_delegation_policy.data: { "scope": string, "maxValue"?: number|null, "requiresOwner"?: boolean, "conditions"?: string }
- delete_delegation_policy.data: { "scope": string }

El input incluye bloque "PERÍMETRO DE DELEGACIÓN:" con las políticas activas.
USALO para responder preguntas como "¿puedo aprobar stock automáticamente?" o detectar si una acción del Companion requiere confirmación.

Ejemplos few-shot — Perímetro de delegación:
- "Los empleados pueden cargar mercadería hasta 50000 pesos sin que yo lo apruebe" → create_delegation_policy, scope="stock", maxValue=50000, requiresOwner=false, conditions="{}", summary="Aprobar ingresos de stock hasta $50.000"
- "Que siempre me consulten antes de cargar stock" → create_delegation_policy, scope="stock", maxValue=null, requiresOwner=true, conditions="{}", summary="Stock siempre requiere aprobación del dueño"
- "Subí el límite de stock a 100000" → update_delegation_policy, scope="stock", maxValue=100000, summary="Límite de stock actualizado a $100.000"
- "Eliminá el límite de stock" → delete_delegation_policy, scope="stock", summary="Perímetro de stock eliminado"
- "¿Cuál es el límite de stock?" → kind:"answer" usando el bloque PERÍMETRO DE DELEGACIÓN del input`;

// SUPERVISOR_EXAMPLES_EMPLOYEES removed 2026-05-25 — the create_employee /
// reset_employee_pin / get_employee_credentials / broadcast_employees few-shots
// now live in EQUIPO_SYSTEM_PROMPT (Equipo Agent, Fase E). The supervisor
// delegates via call_equipo_agent and the captured Pattern C intents flow
// through executeEmployeeActions + executeBroadcastActions unchanged.
