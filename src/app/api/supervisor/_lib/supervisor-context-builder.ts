export interface OnboardingState {
  productCount: number;
  productsWithoutStock: number;
  employeeCount: number;
  stockPolicyMissing?: boolean;
  // Chat-driven onboarding flags. The supervisor uses these to detect which turn
  // it is on without asking the owner to repeat themselves. Each flag flips to
  // true when the matching update_business_setup action lands.
  businessNameSet?: boolean;
  businessTypeSet?: boolean;
  paymentMethodsSet?: boolean;
  openingCashSet?: boolean;
  transferAliasSet?: boolean;
  postalCodeSet?: boolean;
  courierPreferenceSet?: boolean;
  whatsappPhoneSet?: boolean;
}

export interface ActivePolicy {
  scope: string;
  maxValue: number | null;
  requiresOwner: boolean;
}

export interface SupervisorCallContext {
  /** Tenant identifier — threaded through for structured log tenancy. */
  businessId?: string;
  activeRules?: ReadonlyArray<{ kind: string; trigger: string; message: string }>;
  activePolicies?: ReadonlyArray<ActivePolicy>;
  onboardingState?: OnboardingState;
  products?: ReadonlyArray<{ name: string; price: number; stock: number }>;
  employees?: ReadonlyArray<{ name: string; role: string }>;
  cashBalance?: number;
  currency?: string;
  currentTime?: string;
  ackedAlerts?: ReadonlyArray<{ employeeName: string; text: string }>;
  // UI language toggle. Owner switches via Settings (writes localStorage
  // `velora-lang` + cookie `NEXT_LOCALE`). Threaded through so the supervisor
  // prompt can swap its language directive (Spanish rioplatense ↔ English).
  // Defaults to "es-AR" when unset.
  lang?: "en" | "es-AR";
  // Unit 2: Business origin postal code for Andreani quote few-shot injection.
  // Replaces "[origen]" placeholder in the supervisor prompt. null when not set.
  originPostalCode?: string | null;
  // Always-on awareness: compact summary of missing business config fields that
  // block capabilities (shipping, payment links, messaging, invoicing).
  // Built by getMissingBusinessData + summarizeMissingData in owner-handler.ts.
  // null = all configured; injected regardless of onboardingComplete state.
  missingDataSummary?: string | null;
  // Server-loaded conversation history for multi-turn context. Last N user/assistant
  // pairs from ChatMessage table, ordered oldest-first. Passed directly to Gemini
  // startChat({ history }) so the Supervisor maintains conversation continuity.
  conversationHistory?: ReadonlyArray<{ role: "user" | "assistant"; text: string }>;
}

// PL-1 (pre-launch audit): import sanitizeUserInput so user-controlled strings
// (product names, employee names, rule messages, acked alert text) are stripped
// of injection phrases before being interpolated into the Gemini prompt.
import { sanitizeUserInput } from "@/app/api/business-assistant/_lib/shared";

export function buildUserMessage(text: string, context: SupervisorCallContext): string {
  // Block ordering is optimized for Vertex AI implicit caching.
  //
  // Vertex AI caches based on a matching prefix of the full request (system
  // instruction + conversation contents). To maximize cache hits across
  // consecutive calls from the same business, static/slow-changing blocks MUST
  // come first in the user message so they form a stable cacheable prefix.
  // The unique user text (<user_message>) goes LAST — it is the only part that
  // changes on every turn, so it must not appear in the cacheable prefix.
  //
  // Order: most-stable → least-stable → volatile (user text)
  //   1. activeRules     — changes only when owner edits rules
  //   2. activePolicies  — changes only when owner edits delegation policies
  //   3. products        — changes on catalog edits / sales (relatively infrequent)
  //   4. employees       — rarely changes
  //   5. onboarding state — progresses during setup then becomes absent
  //   6. missingData     — same lifecycle as onboarding state
  //   7. cashBalance     — changes on every sale (moderately volatile)
  //   8. ackedAlerts     — changes during the day as alerts are acknowledged
  //   9. currentTime     — truncated to the hour to reduce per-minute cache misses
  //  10. <user_message>  — unique per call; ALWAYS last

  // PL-1: activeRules.message and trigger come from DB but are user-authored —
  // sanitize before prompt interpolation.
  const rulesBlock = context.activeRules?.length
    ? `\n\nREGLAS ACTIVAS:\n${context.activeRules.map((r) => `- [${r.kind}] trigger="${sanitizeUserInput(r.trigger)}" → ${sanitizeUserInput(r.message)}`).join("\n")}`
    : "";
  const policiesBlock = context.activePolicies?.length
    ? `\n\nPERÍMETRO DE DELEGACIÓN:\n${context.activePolicies.map((p) => `- scope="${p.scope}" maxValue=${p.maxValue ?? "sin límite"} requiresOwner=${p.requiresOwner}`).join("\n")}`
    : "\n\nPERÍMETRO DE DELEGACIÓN: sin políticas activas — cualquier acción autónoma requiere confirmación del dueño.";
  // PL-1: product names and employee names are user-controlled — sanitize each
  // before interpolating into the catalog/employees prompt blocks.
  const productsBlock = context.products?.length
    ? `\n\nCATÁLOGO:\n${context.products.map((p) => `- ${sanitizeUserInput(p.name)}: $${p.price} | stock: ${p.stock} u.`).join("\n")}`
    : "";
  const employeesBlock = context.employees?.length
    ? `\n\nEMPLEADOS:\n${context.employees.map((e) => `- ${sanitizeUserInput(e.name)} (${e.role})`).join("\n")}`
    : "";
  const s = context.onboardingState;
  const stateBlock = s
    ? [
        "\n\nESTADO DEL NEGOCIO:",
        `- Nombre del negocio: ${s.businessNameSet ? "cargado" : "pendiente"}`,
        `- Métodos de pago: ${s.paymentMethodsSet ? "cargados" : "pendientes"}`,
        `- Alias/CBU transferencia: ${s.transferAliasSet ? "cargado" : "pendiente"}`,
        `- Código postal: ${s.postalCodeSet ? "cargado" : "pendiente"}`,
        `- Courier: ${s.courierPreferenceSet ? "cargado" : "pendiente"}`,
        `- WhatsApp negocio: ${s.whatsappPhoneSet ? "cargado" : "pendiente"}`,
        `- Productos: ${s.productCount}${s.productsWithoutStock > 0 ? ` (${s.productsWithoutStock} sin stock)` : ""}`,
        `- Reglas: ${context.activeRules?.length ?? 0}`,
        `- Empleados: ${s.employeeCount}`,
        ...(s.stockPolicyMissing ? ["- Perímetro de stock: no configurado"] : []),
      ].join("\n")
    : "";
  // Always-on block: missing config that blocks capabilities. Present even after
  // onboarding completes so the Supervisor never delegates with placeholder data.
  // Only injected when onboardingState is absent (post-onboarding) AND data is
  // actually missing — avoids duplication with the ESTADO DEL NEGOCIO block.
  const missingDataBlock =
    !context.onboardingState && context.missingDataSummary
      ? `\n\n⚙️ CONFIGURACIÓN PENDIENTE DEL NEGOCIO:\n${context.missingDataSummary}`
      : "";
  const cashBlock = context.cashBalance !== undefined
    ? `\n\nCAJA: ${context.currency ?? "ARS"} ${context.cashBalance.toLocaleString("es-AR")}`
    : "";
  // PL-1: employeeName and text inside ackedAlerts are user-controlled strings.
  const ackedBlock = context.ackedAlerts?.length
    ? `\n\nMENSAJES CONFIRMADOS HOY (empleado marcó como leído):\n${context.ackedAlerts.map((a) => `- ${sanitizeUserInput(a.employeeName)}: "${sanitizeUserInput(a.text)}"`).join("\n")}`
    : "";
  // Truncate currentTime to the hour (HH:00) to avoid a cache miss every minute.
  // Minute precision has zero business value for the Supervisor — it only needs
  // to know the time for time-based rule enforcement, where hour granularity is
  // sufficient. Truncation extends the cache TTL window from ~1 min to ~60 min.
  const timeBlock = context.currentTime
    ? `\n\nHORA ACTUAL (Argentina): ${context.currentTime.replace(/:\d{2}$/, ":00")}`
    : "";
  // <user_message> is LAST — unique per call, must not be part of the cached prefix.
  return `${rulesBlock}${policiesBlock}${productsBlock}${employeesBlock}${stateBlock}${missingDataBlock}${cashBlock}${ackedBlock}${timeBlock}\n\n<user_message>\n${text}\n</user_message>`;
}
