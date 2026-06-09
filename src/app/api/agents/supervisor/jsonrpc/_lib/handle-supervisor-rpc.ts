// Supervisor RPC orchestrator — thin handler over callSupervisor + loadSupervisorContext.
// callSupervisor already handles: ADK path, retries, Flash fallback, direct-Gemini path.
// This module wraps it for A2A message/send dispatch.

import { randomUUID } from "crypto";
import { cloudLog } from "@/lib/cloud-logger";
import { loadSupervisorContext } from "@/app/api/supervisor/_lib/load-context";
import { callSupervisor } from "@/app/api/supervisor/_lib/supervisor-runner";
import { safeParseJson } from "@/app/api/supervisor/_lib/supervisor-parser";
import { applySupervisorHallucinationGuard } from "@/app/api/supervisor/_lib/supervisor-hallucination-guard";
import {
  type JsonRpcRequest,
  type JsonRpcResponse,
  type A2APart,
  RPC_ERRORS,
  rpcError,
  rpcResult,
  extractTextFromParams,
  extractContextIdFromParams,
  extractBusinessIdFromText,
} from "@velora/core-utils/jsonrpc-types";

export type { JsonRpcRequest, JsonRpcResponse };
export { RPC_ERRORS, rpcError, extractTextFromParams, extractBusinessIdFromText };

export const SUPERVISOR_MAX_INPUT_CHARS = 4_000;

export async function handleSupervisorRpc(
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

      // Strip the businessId header line from the user-visible message text
      // so it does not appear in the supervisor prompt as conversational content.
      const userText = rawText
        .replace(/^businessId:\s*\S+\s*/m, "")
        .trim()
        .slice(0, SUPERVISOR_MAX_INPUT_CHARS);

      if (!userText) {
        return rpcError(body.id, RPC_ERRORS.INVALID_PARAMS, "Message text is empty after businessId extraction");
      }

      const contextId = extractContextIdFromParams(body.params) ?? randomUUID();
      const businessId = ctx?.businessId ?? null;

      // Load business context the same way the owner-facing route does.
      // Falls back to an empty context when businessId is unavailable so the
      // Supervisor can still respond generically (won't have catalog data).
      let supervisorCtx: Parameters<typeof callSupervisor>[1] = { businessId: businessId ?? undefined };
      if (businessId) {
        try {
          const loaded = await loadSupervisorContext(businessId);
          supervisorCtx = {
            businessId,
            activeRules: loaded.activeRules,
            activePolicies: loaded.activePolicies,
            onboardingState: {
              productCount: loaded.productCount,
              productsWithoutStock: loaded.productsWithoutStock,
              employeeCount: loaded.employeeCount,
              businessNameSet: loaded.businessNameSet,
              businessTypeSet: loaded.businessTypeSet,
              paymentMethodsSet: loaded.paymentMethodsSet,
            },
            products: loaded.products,
            employees: loaded.employees,
            cashBalance: loaded.cashBalance,
            currency: loaded.currency,
            lang: "es-AR",
          };
        } catch (err) {
          cloudLog({
            severity: "WARNING",
            component: "A2A",
            action: "SUPERVISOR_A2A_CONTEXT_LOAD_FAILED",
            a2a_transfer: false,
            message: "loadSupervisorContext threw — proceeding with minimal context",
            businessId,
            data: { error: err instanceof Error ? err.message : String(err) },
          });
        }
      }

      let replyText = "";
      let usedAdkDelegation = false;

      try {
        const { raw, usedAdkDelegation: delegated } = await callSupervisor(userText, supervisorCtx);
        usedAdkDelegation = delegated;
        const parsed = safeParseJson(raw);
        if (parsed) {
          const guarded = applySupervisorHallucinationGuard(parsed, { businessId: businessId ?? undefined });
          replyText = guarded.answer ?? raw;
        } else {
          replyText = raw || "Sin respuesta del Supervisor.";
        }
      } catch (error) {
        cloudLog({
          severity: "ERROR",
          component: "A2A",
          action: "SUPERVISOR_A2A_RPC_ERROR",
          a2a_transfer: false,
          message: "Supervisor A2A RPC call threw",
          businessId: businessId ?? undefined,
          data: {
            errorName: error instanceof Error ? error.name : "NonError",
            errorMessage: error instanceof Error ? error.message : String(error),
            contextId,
          },
        });
        replyText = "Error interno del Supervisor. Intentá de nuevo.";
      }

      const parts: A2APart[] = [
        { kind: "text", text: replyText || "Sin respuesta del modelo." },
        ...(usedAdkDelegation ? [{ kind: "data" as const, data: { usedAdkDelegation: true } }] : []),
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
