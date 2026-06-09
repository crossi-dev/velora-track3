// handle-inventario-rpc.ts — RPC orchestrator for the Inventario Agent.
//
// ADK Agent setup  → adk-inventario-agent.ts
// FunctionTools    → inventario-agent-tools.ts (wires existing stock.* + catalogo.* tools)
//
// Read tools (consultar_stock, consultar_precio) return data directly.
// Mutation tools (gestionar_stock, transferir, gestionar_producto) emit Pattern C intents
// { intent, data, summary } captured here and forwarded as dataParts so the Supervisor's
// downstream pipeline (supervisor-action-mapper.ts → owner-handler.ts) can materialise
// them through the existing idempotent + audited mutation path.
//
// Prefetches the product catalog once per request (DB query, not 90s cache) because the
// RPC handler is a standalone A2A service — it does not share the business-assistant cache.

import { randomUUID } from "crypto";
import { createInventarioAgent } from "./adk-inventario-agent";
import { runRpcAgent } from "@/app/api/agents/_lib/run-rpc-agent";
import { handleRpcRunnerError } from "@/app/api/agents/_lib/rpc-runner-obs";
import { prisma } from "@/lib/prisma";
import { cloudLog } from "@/lib/cloud-logger";
import {
  type JsonRpcRequest,
  type JsonRpcResponse,
  type A2APart,
  type CapturedIntent,
  RPC_ERRORS,
  rpcError,
  rpcResult,
  extractTextFromParams,
  extractContextIdFromParams,
  extractBusinessIdFromText,
} from "@velora/core-utils/jsonrpc-types";

export type { JsonRpcRequest, JsonRpcResponse };
export { RPC_ERRORS, rpcError, extractTextFromParams, extractBusinessIdFromText };

export const INVENTARIO_MAX_INPUT_CHARS = 4_000;

// ADK runner timeout — env-overridable so Cloud Run can tune without a redeploy.
// Default 30s: inventory ops are read-heavy + Flash tool-calling round-trip.
// Outer A2A client (INVENTARIO_AGENT_TIMEOUT_MS) = 42s = inner 30s + 12s margin.
// Source: Google SRE Book — Deadline Propagation (Addressing Cascading Failures)
// https://sre.google/sre-book/addressing-cascading-failures/
const INVENTARIO_ADK_TIMEOUT_MS = Number(
  process.env.INVENTARIO_ADK_TIMEOUT_MS ?? "30000",
);

// Maximum products to load for the in-request catalog snapshot.
// Mirrors PRODUCT_FETCH_LIMIT in owner-assistant-catalog.ts.
const PRODUCT_FETCH_LIMIT = 30;

/** Minimal product shape needed by StockToolsBackend and CatalogoToolsBackend. */
interface ProductRow {
  id: string;
  name: string;
  price: number;
  quantity: number;
  sku: string | null;
}

async function loadInventarioBackend(businessId: string) {
  const [business, products] = await Promise.all([
    prisma.business.findUnique({
      where: { id: businessId },
      select: { id: true, name: true, userId: true, currency: true },
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Prisma DLL lock on Windows
    (prisma as any).product.findMany({
      where: { businessId },
      select: { id: true, name: true, price: true, quantity: true, sku: true },
      orderBy: { name: "asc" },
      take: PRODUCT_FETCH_LIMIT,
    }) as Promise<ProductRow[]>,
  ]);

  if (!business) return null;

  const productDirectory = products.map((p) => ({
    id: p.id,
    name: p.name,
    sku: p.sku,
    price: p.price,
    stock: p.quantity,
  }));

  const inventorySummary = {
    productLines: productDirectory.length,
    totalUnits: productDirectory.reduce((s, p) => s + p.stock, 0),
    totalValue: productDirectory.reduce((s, p) => s + p.price * p.stock, 0),
  };

  // Business model does not have a locale field; use the AR default.
  const locale = "es-AR";
  const currency = business.currency ?? "ARS";

  return {
    businessId,
    // StockToolsBackend.actorUserId is typed as string (not null); provide a
    // sentinel string when the owner user record is unexpectedly absent so the
    // audit trail is marked clearly rather than silently coercing null.
    actorUserId: business.userId ?? "unknown-owner",
    actorEmployeeId: null,
    productDirectory,
    locale,
    currency,
    business: { name: business.name, currency },
    inventorySummary,
  };
}

export async function handleInventarioRpcAsync(
  body: JsonRpcRequest,
  ctx?: { businessId?: string | null },
): Promise<JsonRpcResponse> {
  if (!body || body.jsonrpc !== "2.0" || typeof body.method !== "string") {
    return rpcError(body?.id, RPC_ERRORS.INVALID_REQUEST);
  }

  switch (body.method) {
    case "message/send": {
      const text = extractTextFromParams(body.params);
      if (!text) {
        return rpcError(
          body.id,
          RPC_ERRORS.INVALID_PARAMS,
          "message.parts must contain at least one text part",
        );
      }

      const contextId = extractContextIdFromParams(body.params) ?? randomUUID();
      const turnId = randomUUID();
      const capturedIntents: CapturedIntent[] = [];

      const businessId = ctx?.businessId ?? null;

      // W-3: early-return when businessId is absent — actorUserId would be null
      // which corrupts the audit trail on any mutation tool.
      if (!businessId) {
        cloudLog({
          severity: "ERROR",
          component: "A2A",
          action: "INVENTARIO_AGENT_MISSING_BUSINESS_ID",
          a2a_transfer: false,
          message: "Inventario agent received no businessId in ctx — rejecting request",
          data: { contextId },
        });
        return rpcError(body.id, RPC_ERRORS.INVALID_PARAMS, "businessId is required");
      }

      // Load product catalog + business metadata for the tool backend.
      let toolsBackend: Awaited<ReturnType<typeof loadInventarioBackend>> = null;
      try {
        toolsBackend = await loadInventarioBackend(businessId);
      } catch (err) {
        cloudLog({
          severity: "WARNING",
          component: "A2A",
          action: "INVENTARIO_BACKEND_LOAD_ERROR",
          a2a_transfer: false,
          message: "Failed to load Inventario backend — tools will run with empty catalog",
          businessId,
          data: { error: err instanceof Error ? err.message : String(err) },
        });
      }

      // W-3: if backend load failed (DB error), early-return — do not allow
      // actorUserId: null into the audit trail.
      if (!toolsBackend) {
        return rpcError(body.id, RPC_ERRORS.INTERNAL_ERROR, "No se pudo cargar el backend de inventario. Reintentá.");
      }

      const agent = createInventarioAgent({
        businessId,
        actorUserId: toolsBackend.actorUserId,
        turnId,
        toolsBackend,
      });

      // W-1: track whether any mutation tool actually called, so a reply that
      // claims a stock/product mutation without a real intent can be blocked.
      let inventarioToolCalled = false;

      const { replyText, error } = await runRpcAgent({
        agent,
        appName: "velora-inventario-agent",
        userId: "inventario-rpc-call",
        message: text,
        timeoutMs: INVENTARIO_ADK_TIMEOUT_MS,
        onFunctionResponse: ({ response }) => {
          inventarioToolCalled = true;
          if (!response) return;
          const r = response as Record<string, unknown>;
          if (
            typeof r.intent === "string" &&
            r.data !== undefined &&
            typeof r.summary === "string"
          ) {
            capturedIntents.push({
              intent: r.intent,
              data: r.data,
              summary: r.summary,
            });
          }
        },
      });

      if (error !== null) {
        const classified = handleRpcRunnerError(
          error,
          "Inventario",
          body,
          contextId,
          businessId,
          INVENTARIO_ADK_TIMEOUT_MS,
        );
        if (classified.earlyResponse !== null) return classified.earlyResponse;
        const parts: A2APart[] = [{ kind: "text", text: classified.replyText }];
        return rpcResult(body.id, {
          kind: "message",
          messageId: randomUUID(),
          role: "agent",
          parts,
          contextId,
        });
      }

      // W-1: no-tool-call hallucination guard. If the reply asserts a stock/product
      // mutation but no tool executed, the DB was never written — block it.
      // Pattern mirrors jd/caja-agent W-3 (handle-caja-rpc.ts).
      const claimsInventarioMutation =
        /stock\s+(ajustad|cargad|actualizad)|producto\s+(actualizad|creado)|transferencia\s+(realizada|completada)/i.test(replyText);
      if (claimsInventarioMutation && !inventarioToolCalled) {
        cloudLog({
          severity: "ERROR",
          component: "System",
          action: "INVENTARIO_NO_TOOL_HALLUCINATION",
          a2a_transfer: false,
          message: "Inventario agent claimed a stock/product mutation with no tool call — blocking (no DB write happened).",
          businessId,
          data: { replyPreview: replyText.slice(0, 120) },
        });
        const blockParts: A2APart[] = [
          { kind: "text", text: "No pude completar la operación en este momento. Probá de nuevo." },
        ];
        return rpcResult(body.id, {
          kind: "message",
          messageId: randomUUID(),
          role: "agent",
          parts: blockParts,
          contextId,
        });
      }

      const parts: A2APart[] = [
        { kind: "text", text: replyText || "Sin respuesta del modelo." },
        ...(capturedIntents.length > 0
          ? [{ kind: "data" as const, data: { intents: capturedIntents } }]
          : []),
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
