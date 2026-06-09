// Fiscal-setup mini-flow stage — intercepts invoice/comprobante intents when
// Business.cuit is null and routes the owner through the 3-step collection flow.
//
// TRIGGER MECHANISM:
//   We use a deterministic pre-model stage inserted AFTER onboarding and BEFORE
//   the dispatcher. This is the lowest-risk approach for two reasons:
//   1. The existing invoice detector (label "9" in detect.ts) already works correctly
//      for businesses that have CUIT — we do not touch it.
//   2. A supervisor-prompt conditional block would fire on every turn (extra tokens)
//      and would give the LLM discretion over when to collect data; here we collect
//      it deterministically before the LLM sees the request.
//
// The stage has three modes:
//   (a) Owner says an invoice/comprobante keyword + cuit IS NULL → show gate prompt.
//   (b) Owner is mid-flow (cuit IS NULL, iva/pv not yet set) + text matches the
//       current step's parser → capture the data and advance.
//   (c) Everything else (cuit already set, or no invoice intent) → return null.
//
// ADDITIVE: businesses that have a cuit set are never intercepted (mode c).

import { normalizeForMatching } from "@/lib/normalize";
import { cloudLog } from "@/lib/cloud-logger";
import { loadSupervisorContext } from "@/app/api/supervisor/_lib/load-context";
import { executeBusinessSetupActions } from "@/app/api/supervisor/_lib/business-setup-actions";
import { getFiscalReadiness } from "@/app/api/agents/fiscal/jsonrpc/_lib/fiscal-readiness";
import {
  detectFiscalSetupFastPath,
  buildFiscalSetupGatePrompt,
} from "./onboarding-fast-path.fiscal-setup";
import type { OwnerPipelineStage } from "./owner-handler.stages";

// ── Invoice/comprobante keyword gate ──────────────────────────────────────────
// Deliberately narrow: only words that unambiguously signal a fiscal/invoice need.
// "factura" already in DETERMINISTIC_HINT_RE — we accept that overlap; a hint-check
// miss (raw text, not normalized) should not suppress the fiscal gate.
const FISCAL_INTENT_RE =
  /\b(factura|factur\w*|comprobante|arca|afip|fiscal|emitir|emiti\w*|recib\w*)\b/i;

// Sales/revenue QUERY phrasings that contain "facturé/vendí/gané" in past tense
// — these are reporting queries ("how much did I bill/sell today?"), NOT invoice
// emission actions. Without this guard, "cuánto facturé hoy" triggers the fiscal
// setup flow via FISCAL_INTENT_RE's `factur\w*` stem.
// Bug: live eval 2026-06-02 — "cuánto facturé hoy" showed "Para emitir comprobantes
// necesito el CUIT..." instead of routing to the sales report.
// The guard checks for a revenue-query shape (cuánto/cuánta + past-tense verb)
// BEFORE the fiscal gate so the Supervisor LLM can answer it correctly.
const SALES_QUERY_RE =
  /\bcu[aá]nto\s+(?:factur[eé]|vend[ií]|gan[eé]|cobr[eé]|hice|hici)\b/i;

function looksLikeFiscalIntent(text: string): boolean {
  if (!text) return false;
  const normalized = normalizeForMatching(text);
  // Past-tense revenue query ("cuánto facturé / vendí / gané hoy") —
  // disambiguate from fiscal emission intent before the broad stem matches.
  if (SALES_QUERY_RE.test(normalized)) return false;
  return FISCAL_INTENT_RE.test(normalized);
}

// ── Stage ─────────────────────────────────────────────────────────────────────

export const ownerFiscalSetupStage: OwnerPipelineStage = {
  name: "ownerFiscalSetup",
  run: async (ctx) => {
    const { text, businessId, actorUserId, trace, latency, respond } = ctx.params;
    if (!text || !text.trim()) return null;

    latency.start("preModel");
    const supCtx = await loadSupervisorContext(businessId);
    latency.end("preModel");

    const fiscalState = {
      cuitSet: supCtx.cuitSet,
      ivaConditionSet: supCtx.ivaConditionSet,
      puntoVentaSet: supCtx.puntoVentaSet,
    };

    // Mode (c): business has all three fiscal fields set.
    // Sub-mode (c1): fiscal intent detected → check ArcaCredential readiness.
    // Sub-mode (c2): no fiscal intent → pass through to LLM normally.
    if (fiscalState.cuitSet && fiscalState.ivaConditionSet && fiscalState.puntoVentaSet) {
      if (!looksLikeFiscalIntent(text)) return null;

      const readiness = await getFiscalReadiness(businessId);
      if (readiness.ready) return null; // Credential present → real emission path

      // Credential missing — surface the guidance proactively instead of a silent fake invoice.
      trace.add("routing", "owner → fiscal-readiness gate (no ArcaCredential)");
      latency.setMeta("path", "owner-fiscal-readiness-gate");
      latency.emit({ businessId, actorUserId, actorEmployeeId: null });

      cloudLog({
        severity: "INFO",
        component: "Fiscal",
        action: "FISCAL_READINESS_GATE_SHOWN",
        a2a_transfer: false,
        message: "fiscal-readiness gate shown — ArcaCredential missing",
        businessId,
        data: { missing: readiness.missing },
      });

      return respond({ answer: readiness.guidance, actions: [], chips: null });
    }

    const isMidFlow = !fiscalState.cuitSet || !fiscalState.ivaConditionSet || !fiscalState.puntoVentaSet;

    // Mode (a): no fiscal intent keyword and not mid-flow → pass through.
    if (!isMidFlow) return null;

    // If we are mid-flow (some data captured but not complete), try the parser
    // regardless of whether there is an invoice keyword — the owner is answering
    // the current step's question.
    // If we are NOT mid-flow (cuit is null and no prior fiscal turn), only intercept
    // when the text contains an invoice intent keyword.
    const isNewTrigger = !fiscalState.cuitSet && !looksLikeFiscalIntent(text);
    if (isNewTrigger) return null;

    // Mode (b) / fresh trigger: run the state machine.
    const result = detectFiscalSetupFastPath(text, fiscalState);

    // Fresh trigger with no CUIT collected yet → show gate prompt (FS0).
    if (result === null && !fiscalState.cuitSet && looksLikeFiscalIntent(text)) {
      trace.add("routing", "owner → fiscal-setup gate (no CUIT)");
      latency.setMeta("path", "owner-fiscal-setup-gate");
      latency.emit({ businessId, actorUserId, actorEmployeeId: null });

      cloudLog({
        severity: "INFO",
        component: "System",
        action: "FISCAL_SETUP_GATE_SHOWN",
        a2a_transfer: false,
        message: "fiscal-setup gate shown — owner has no CUIT",
        businessId,
        data: { fiscalState },
      });

      const gate = buildFiscalSetupGatePrompt();
      return respond({ answer: gate.answer, actions: [], chips: gate.chips });
    }

    // State machine returned null but mid-flow → user is answering a different
    // question or typing something unrelated; fall through to LLM for flexibility.
    if (result === null) return null;

    // Validation error (e.g. wrong CUIT digit): return the error message, stay on step.
    if (result.matchedStep === "error") {
      trace.add("routing", "owner → fiscal-setup validation error");
      return respond({ answer: result.answer, actions: [], chips: null });
    }

    // Good match: persist and advance.
    if (result.actions.length > 0) {
      const seed = `${ctx.params.inboundEventId ?? "fiscal-setup"}|${businessId}|${actorUserId}`;
      const persisted = await executeBusinessSetupActions(result.actions, businessId, actorUserId, seed);
      if (persisted.errors.length > 0) {
        cloudLog({
          severity: "WARNING",
          component: "System",
          action: "FISCAL_SETUP_PERSIST_FAILED",
          a2a_transfer: false,
          message: "fiscal-setup persist failed — falling through to supervisor",
          businessId,
          data: { errors: persisted.errors, step: result.matchedStep },
        });
        return null;
      }
    }

    cloudLog({
      severity: "INFO",
      component: "System",
      action: "FISCAL_SETUP_STEP_DONE",
      a2a_transfer: false,
      message: `fiscal-setup step ${String(result.matchedStep)} completed deterministically`,
      businessId,
      data: { step: result.matchedStep },
    });

    trace.add("routing", `owner → fiscal-setup step ${String(result.matchedStep)}`);
    latency.setMeta("path", "owner-fiscal-setup");
    latency.emit({ businessId, actorUserId, actorEmployeeId: null });
    return respond({ answer: result.answer, actions: [], chips: result.chips });
  },
};
