// ─────────────────────────────────────────────────────────────────────────────
// OnboardingAgent — interface contract (step 1 of the agent split).
//
// This file is design-only. It declares the shape the new OnboardingAgent will
// expose to the rest of Velora; no runtime calls live here. The contract is
// the single source of truth that downstream pieces (ADK runner, A2A
// endpoints, owner-handler stage, tests, agent card) will conform to.
//
// Why a contract file before any runtime code:
//   1. Locks the inputs/outputs the agent owns before behavior is written.
//   2. Becomes the input to the Velora agent-factory scaffolder (planned).
//   3. Makes the agent reviewable as a unit — one PR audits the contract,
//      subsequent PRs only implement against it.
//
// Architecture position (per Google ADK 2026 + A2A 0.3.x):
//   - OnboardingAgent is a SUB-AGENT (stateful, context-dependent), not a tool.
//   - Onboarding v3 (2026-06-04): it owns exactly TWO conversational turns —
//     business name + catalog offer. Payment, shipping, WhatsApp, AFIP and
//     customers are eventually_due integrations collected from the
//     SetupChecklist dashboard card, NOT chat turns (Stripe incremental
//     onboarding — currently_due vs eventually_due).
//   - The Supervisor (gemini-2.5-pro) ROUTES owner messages here while the
//     business is not yet through onboarding (name or catalog still pending).
//     Once both are resolved, the Supervisor stops delegating to this agent.
//   - The agent exposes itself via A2A 0.3.x-style endpoints so it is
//     discoverable and signable, matching existing Velora sub-agents
//     (Logística, Pagos, Fiscal, Companion, ML).
// ─────────────────────────────────────────────────────────────────────────────

import type { ChipsBundle } from "@/app/api/supervisor/_lib/supervisor-chips";
// SupervisorAction removed in step 4/5: actions[] replaced by FunctionTool dispatch.

// ── Model selection ─────────────────────────────────────────────────────────
//
// gemini-2.5-flash: structured prompts + bounded turn machine + high call
// volume during the first minutes of a new business = Flash is the right
// tier. Pro is overkill (and 5–10× more expensive per call). Lite is too
// thin for the conversational repair turns ("no entiendo", "explicame").
//
// Region: us-south1 — same Vertex AI region used by the Supervisor today
// Keeps the deploy-time env override surface minimal.
export const ONBOARDING_AGENT_MODEL = "gemini-2.5-flash" as const;
export const ONBOARDING_AGENT_VERTEX_LOCATION = "us-south1" as const;

// ── Runtime input ───────────────────────────────────────────────────────────
//
// What the OnboardingAgent receives on every owner turn during onboarding.
// Mirrors the supervisor's existing context shape so wiring the owner-handler
// stage is a one-line redirect, not a refactor.
export interface OnboardingAgentInput {
  /** Raw owner-typed text. Free-text or chip value, untrimmed. */
  text: string;
  /** Language code for the response. Defaults to "es-AR" inside Velora. */
  lang: "es-AR" | "en-US";
  /** Tenant scope. Drives idempotency keys + agent-card auth. */
  businessId: string;
  /** Owner user id (NextAuth sub). Used for action attribution + traces. */
  actorUserId: string;
  /**
   * Snapshot of the onboarding state machine the supervisor would otherwise
   * load (loadSupervisorContext). Lets the agent skip turns whose data is
   * already persisted (e.g. paymentMethodsSet=true → skip T3).
   */
  state: OnboardingState;
  /** Last N owner+assistant turns. Used for conversational repair context. */
  recentHistory: Array<{ role: "owner" | "assistant"; text: string }>;
  /** Optional. Idempotency anchor for downstream action emission. */
  inboundEventId?: string | null;
}

/** Subset of supervisor business context the agent actually needs. */
export interface OnboardingState {
  businessNameSet: boolean;
  paymentMethodsSet: boolean;
  paymentMethodsIncludeTransferencia: boolean;
  transferAlias: string | null;
  transferAliasSet: boolean;
  postalCodeSet: boolean;
  courierPreferenceSet: boolean;
  courierPreference: string | null;
  whatsappPhoneSet: boolean;
  productCount: number;
  pendingStockProduct: { productId: string; name: string } | null;
  mercadoPagoSelected: boolean;
  mercadoPagoConnected: boolean;
  mercadoPagoOnboardingDeferred: boolean;
  customerCount: number;
  customersOnboardingSkipped: boolean;
  arcaCertConnected: boolean;
  arcaOnboardingDeferred: boolean;
  courierCredentialsConnected: boolean;
  andreaniOnboardingDeferred: boolean;
  // BYOA pending steps — non-null while awaiting credential paste from owner.
  // T13: "awaiting_cuit" | null. T14: "awaiting_token" | null.
  arcaPendingStep: string | null;
  andreaniPendingStep: string | null;
  // Onboarding redesign 2026-05-25 flags.
  skippedCatalog: boolean;
  firstSalePromptShown: boolean;
}

// ── Runtime output ──────────────────────────────────────────────────────────
//
// Step 4/5 rewrite (camino B conservative):
// - matchedTurn removed: the LLM picks the tool based on currently_due, so the
//   runner no longer needs the turn number.
// - actions removed: persistence is handled by FunctionTool dispatch in
//   runOnboardingAgent; the caller receives the composed output, not raw actions.
// - clientAction / clientActionParams: produced by the tool handler and merged
//   into the output by dispatchTool() in the runner.
//
// Polish asymmetry (intentional): onboarding-polish.ts only rephrases
// fast-path acks because the agent already writes warm Rioplatense prose per
// its system prompt. Running polish on the agent output would be a second
// LLM hop with no quality lift, +600-1200ms per turn, and double the Flash
// spend. Voices may differ slightly across paths; that is preferred over the
// added latency.
export interface OnboardingAgentOutput {
  /** Visible reply text. Always set, possibly multi-paragraph. */
  answer: string;
  /** Chip suggestions for the next turn. null when no chips apply. */
  chips: ChipsBundle | null;
  /**
   * clientAction / clientActionParams: emitted by the tool handler, merged
   * into the output by the runner. Enum-bounded via CLIENT_ACTION_VALUES to
   * prevent the model from inventing unknown action strings — the client only
   * handles these exact values. The runtime Set in onboarding-agent.ts is
   * derived from CLIENT_ACTION_VALUES so both stay in sync by construction.
   */
  clientAction?: ClientActionType;
  clientActionParams?: { panel?: ClientActionPanel };
}

// ── clientAction canonical allowlist ────────────────────────────────────────
//
// Single source of truth for clientAction values the client handles.
//   - TypeScript union (ClientActionType) is derived from this array.
//   - The runtime Set used by validateClientAction() in onboarding-agent.ts
//     is also derived here so both paths can never diverge.
//
// Adding a new action: add the string here; TypeScript + the runtime Set
// both update automatically via the derivation below.
export const CLIENT_ACTION_VALUES = [
  "open_photo_picker",
  "open_file_picker",
  "open_mp_oauth",
  "open_settings",
] as const;

export type ClientActionType = (typeof CLIENT_ACTION_VALUES)[number];

export const CLIENT_ACTION_PANEL_VALUES = [
  "contactos",
  "negocio.fiscal",
  "logistica.andreani",
  "logistica.oca",
  "logistica.correo",
] as const;

export type ClientActionPanel = (typeof CLIENT_ACTION_PANEL_VALUES)[number];

// ── Tool surface ────────────────────────────────────────────────────────────
//
// The agent invokes exactly these tools. Every other action goes through the
// supervisor — keeps the agent's blast radius bounded to onboarding fields.
//
// Tool implementations live in src/app/api/business-assistant/_lib/
// onboarding-agent.tools.ts and onboarding-agent.tools.payment-shipping.ts.
// The contract here is the ALLOWED list. Adding a tool is a contract change
// + a code change + a card update; the factory template enforces the trio.
// Source: https://google.github.io/adk-docs/tools/function-tools/
// Onboarding v3 (2026-06-04): the agent owns name + catalog only.
// connect_payment_method / connect_shipping_provider were removed — those are
// eventually_due integrations driven from the SetupChecklist dashboard card.
export const ONBOARDING_AGENT_TOOLS = [
  "save_business_name",
  "import_catalog",
] as const;
export type OnboardingAgentToolName = (typeof ONBOARDING_AGENT_TOOLS)[number];

/**
 * Result schema for import_catalog (exposed so Gemini's tool-result awareness
 * is documented alongside the FunctionTool allowlist).
 *
 * Design §7.1: partial paste success is first-class — successCount/totalCount
 * are always present on the paste path. The caller (dispatchTool) uses these
 * to report the real count to the user instead of the LLM's generated text.
 */
export interface ImportCatalogToolResult {
  ok: boolean;
  confirmation: string | null;
  error: string | null;
  catalogReadyNow: boolean;
  /** Products successfully created (paste path). Always 0 for skip/file/photo. */
  successCount: number;
  /** Products attempted (paste path). Always 0 for skip/file/photo. */
  totalCount: number;
  clientAction?: "open_file_picker" | "open_photo_picker";
}

// ── A2A agent card metadata ─────────────────────────────────────────────────
//
// Card content served at /api/agents/onboarding/agent-card (signed via
// signAgentCard). All Velora cards declare protocolVersion "0.3.0" in lockstep
// — the version of the official @a2a-js/sdk (0.3.13) we actually run; the SDK
// 1.0 is alpha-only. Spec: https://a2a-protocol.org/latest/specification/.
export const ONBOARDING_AGENT_CARD_META = {
  protocolVersion: "0.3.0",
  name: "Velora Onboarding Agent",
  description:
    "Dedicated agent for the conversational onboarding of a new business owner. " +
    "Owns two turns: business name and catalog loading (upload / photo / paste / skip). " +
    "Persists each captured field via update_business_setup and routes back to the " +
    "Supervisor once both are resolved. Other integrations (WhatsApp, Mercado Pago, " +
    "AFIP, Andreani) are completed later from the dashboard setup card, not in chat.",
  version: "1.0.0",
  provider: { organization: "Velora", url: "https://somosvelora.com" } as const,
  capabilities: {
    streaming: false,
    pushNotifications: false,
    stateTransitionHistory: true,
  },
  defaultInputModes: ["text"],
  defaultOutputModes: ["text", "data"],
  skills: [
    {
      id: "guide-onboarding-turn",
      name: "Guía un turno del onboarding",
      description:
        "Recibe el último mensaje del dueño + estado del negocio. Decide el turno " +
        "actual (nombre o catálogo), persiste el dato si corresponde, devuelve la " +
        "siguiente pregunta + chips.",
      examples: [
        // Name turn — free text name
        { input: { text: "Distribuidora Norte", state: "fresh" }, output: "name ack" },
        // Name turn — confusion
        { input: { text: "no entiendo", state: "fresh" }, output: "explainer + name question" },
        // Catalog turn — chip
        { input: { text: "Subí tu planilla", state: "name-set" }, output: "open file picker" },
      ],
    },
  ],
  identityKid: "velora-onboarding-v1",
} as const;

// ── Routing contract (Supervisor → OnboardingAgent) ────────────────────────
//
// The Supervisor decides whether to call OnboardingAgent on each turn. The
// rule is pure: if detectPendingTurn(state) returns a number, delegate; if
// null, do NOT delegate (onboarding finished).
//
// This contract documents WHY (so the supervisor prompt + the routing code
// stay aligned) and gives the agent factory a slot to copy when generating
// future sub-agents.
export const ONBOARDING_AGENT_ROUTING_RULE =
  "Delegate to OnboardingAgent when detectPendingTurn(supervisorBusinessContext) !== null. " +
  "Once it returns null, the supervisor handles the turn directly.";

// ── Timeouts ────────────────────────────────────────────────────────────────
//
// 18s is below the supervisor's 25s ADK budget — gives the orchestrator
// headroom to fall back without hitting the outer 40s wrapper. Flash p99
// for prompts of this size is ~6s, so 18s covers the slow tail comfortably.
export const ONBOARDING_AGENT_ADK_TIMEOUT_MS = 18_000;
export const ONBOARDING_AGENT_ATTEMPT_TIMEOUT_MS = 8_000;
export const ONBOARDING_AGENT_MAX_ATTEMPTS = 1;
