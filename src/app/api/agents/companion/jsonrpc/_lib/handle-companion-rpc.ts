// Companion RPC handler — thin adapter over the existing Companion reasoning logic.
//
// Translates an A2A JSON-RPC message/send payload into the arguments expected by
// runBusinessAssistantModel, then applies the same RBAC gate the pipeline uses.
// Does NOT replicate the full business-assistant pipeline (idempotency, B1/B2
// escalation, permission expiration) — those are HTTP-session concerns. The
// A2A caller (Supervisor) is responsible for its own retry / escalation logic.

import { randomUUID } from "crypto";
import { loadBusinessAssistantContext } from "@/app/api/business-assistant/_lib/context";
import { runBusinessAssistantModel, type AdkToolContext } from "@/app/api/business-assistant/_lib/model";
import { rbacGuard } from "@/app/api/business-assistant/_lib/rbac-policy";
import { cloudLog } from "@/lib/cloud-logger";
import {
  rpcError,
  rpcResult,
  RPC_ERRORS,
  extractTextFromParams,
  extractContextIdFromParams,
  extractBusinessIdFromText,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type A2APart,
} from "@velora/core-utils/jsonrpc-types";

export type { JsonRpcRequest, JsonRpcResponse };
export { rpcError, RPC_ERRORS, extractTextFromParams, extractBusinessIdFromText };

// Max chars for the employee message — mirrors PAYMENTS_MAX_INPUT_CHARS.
const COMPANION_MAX_INPUT_CHARS = 1_000;

// ── History extraction ────────────────────────────────────────────────────────
// The A2A caller may embed prior turns as a JSON-encoded "history" data part
// alongside the text part. If absent or malformed, we proceed with empty history.

interface HistoryEntry {
  role: "user" | "assistant";
  text: string;
}

function extractHistoryFromParams(params: unknown): HistoryEntry[] {
  if (!params || typeof params !== "object") return [];
  const message = (params as { message?: unknown }).message;
  if (!message || typeof message !== "object") return [];
  const parts = (message as { parts?: unknown }).parts;
  if (!Array.isArray(parts)) return [];

  for (const part of parts) {
    if (
      part &&
      typeof part === "object" &&
      (part as { kind?: unknown }).kind === "data"
    ) {
      const data = (part as { data?: unknown }).data;
      if (!Array.isArray(data)) continue;
      const entries: HistoryEntry[] = [];
      for (const item of data) {
        if (
          item &&
          typeof item === "object" &&
          typeof (item as HistoryEntry).text === "string" &&
          ((item as HistoryEntry).role === "user" ||
            (item as HistoryEntry).role === "assistant")
        ) {
          entries.push({
            role: (item as HistoryEntry).role,
            text: ((item as HistoryEntry).text as string).slice(0, 1_500),
          });
        }
      }
      if (entries.length > 0) return entries.slice(-12);
    }
  }
  return [];
}

// ── Lang extraction ────────────────────────────────────────────────────────────
// Optional "lang" field in the params object; defaults to es-AR.

function extractLangFromParams(params: unknown): "en" | "es-AR" {
  if (!params || typeof params !== "object") return "es-AR";
  const lang = (params as { lang?: unknown }).lang;
  return lang === "en" ? "en" : "es-AR";
}

// ── Main handler ──────────────────────────────────────────────────────────────

export async function handleCompanionRpcAsync(
  body: JsonRpcRequest,
  ctx?: { businessId?: string | null },
): Promise<JsonRpcResponse> {
  if (!body || body.jsonrpc !== "2.0" || typeof body.method !== "string") {
    return rpcError(body?.id, RPC_ERRORS.INVALID_REQUEST);
  }

  switch (body.method) {
    case "message/send": {
      const rawText = extractTextFromParams(body.params);
      if (!rawText) {
        return rpcError(
          body.id,
          RPC_ERRORS.INVALID_PARAMS,
          "message.parts must contain at least one text part",
        );
      }

      // Strip the businessId header line from the employee text before passing
      // to the model — same pattern as the Payments agent.
      const text = rawText
        .replace(/^businessId:\s*\S+\s*\n?/m, "")
        .slice(0, COMPANION_MAX_INPUT_CHARS)
        .trim();

      if (!text) {
        return rpcError(
          body.id,
          RPC_ERRORS.INVALID_PARAMS,
          "No employee text found after stripping the businessId header line",
        );
      }

      const businessId = ctx?.businessId ?? null;
      if (!businessId) {
        return rpcError(
          body.id,
          RPC_ERRORS.INVALID_PARAMS,
          "businessId is required",
        );
      }

      const contextId = extractContextIdFromParams(body.params) ?? randomUUID();
      const lang = extractLangFromParams(body.params);
      const history = extractHistoryFromParams(body.params);

      // Load business context — same function the main route uses.
      const loadedContext = await loadBusinessAssistantContext(businessId);
      if (!loadedContext) {
        cloudLog({
          severity: "WARNING",
          component: "Companion",
          action: "COMPANION_RPC_BUSINESS_NOT_FOUND",
          a2a_transfer: true,
          message: "Business not found for Companion A2A call",
          businessId,
          data: {},
        });
        return rpcError(
          body.id,
          RPC_ERRORS.INVALID_PARAMS,
          "Business not found",
        );
      }

      let answer = "";
      let intent: string | null = null;
      let rbacBlocked = false;

      // Build adkToolContext from loadedContext so the Companion's FunctionTools
      // (register_sale, business_query, escalate_to_owner) are wired
      // on the A2A path — mirrors the HTTP path in employee-handler.stages-b.ts.
      // Without this, tools are silently stripped and the agent degrades to
      // prompt+parse.
      const ctxInner = loadedContext.context;
      const adkToolContext: AdkToolContext = {
        registerSale: {
          productDirectory: loadedContext.productInfoDirectory,
          customers: loadedContext.fullCatalogCustomers,
        },
        businessQuery: {
          productDirectory: loadedContext.productInfoDirectory,
          context: ctxInner,
          locale: lang,
          business: { name: ctxInner.business.name, currency: ctxInner.business.currency },
          inventorySummary: ctxInner.inventorySummary,
        },
        escalateToOwner: {
          businessId,
          // A2A callers (the Supervisor) don't bind a specific employee — the
          // escalation is on behalf of the system as a whole. The owner_only
          // ChatMessage will be tagged with actor=system in the clientMessageId.
          actorEmployeeId: null,
          actorName: null,
        },
      };

      try {
        const modelResult = await runBusinessAssistantModel(
          loadedContext.context,
          text,
          history,
          /* fewShotExamples */ "",
          /* documentContext  */ "",
          lang,
          adkToolContext,
        );

        const safeIntent = modelResult.safeIntent;
        intent = safeIntent;

        // Apply the same RBAC guard the pipeline uses for employee turns.
        const rbacResult = rbacGuard({ kind: "employee" }, safeIntent);
        if (!rbacResult.allowed) {
          rbacBlocked = true;
          answer = rbacResult.reason ?? "Esa acción la tiene que hacer el dueño.";
          cloudLog({
            severity: "INFO",
            component: "Companion",
            action: "COMPANION_RPC_RBAC_BLOCKED",
            a2a_transfer: true,
            message: `RBAC blocked intent=${safeIntent} on A2A call`,
            businessId,
            data: { intent: safeIntent },
          });
        } else {
          answer = modelResult.answer;
        }
      } catch (error) {
        cloudLog({
          severity: "ERROR",
          component: "Companion",
          action: "COMPANION_RPC_MODEL_ERROR",
          a2a_transfer: true,
          message: "Companion model threw during A2A call",
          businessId,
          data: {
            errorName: error instanceof Error ? error.name : "NonError",
            errorMessage: error instanceof Error ? error.message : String(error),
          },
        });
        answer = "Error interno del Companion. Intentá de nuevo.";
      }

      const parts: A2APart[] = [
        { kind: "text", text: answer || "Sin respuesta del modelo." },
        {
          kind: "data",
          data: {
            intent: intent ?? "answer",
            rbacBlocked,
          },
        },
      ];

      return rpcResult(body.id, {
        kind: "message",
        messageId: randomUUID(),
        role: "agent",
        parts,
        contextId,
      });
    }

    case "tasks/get":
    case "tasks/cancel":
      return rpcError(body.id, RPC_ERRORS.TASK_NOT_FOUND);

    default:
      return rpcError(body.id, RPC_ERRORS.METHOD_NOT_FOUND);
  }
}
