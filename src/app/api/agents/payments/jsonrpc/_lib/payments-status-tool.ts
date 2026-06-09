// payments-status-tool.ts — FunctionTool factory for get_payment_status.
// Extracted from payments-agent-tools.ts to keep that file under the 300-line limit.
//
// SEAM: execute() delegates status resolution to PaymentsBackend.getPaymentStatus
// (via createPaymentsBackend factory) instead of calling resolveCustomerIdByName,
// prisma.paymentIntent, and getPaymentProvider inline. This removes the duplicated
// logic that already lives in VeloraPaymentsAdapter.getPaymentStatus.
//
// LATENCY NOTE: The adapter calls getPaymentProvider(businessId) without a snapshot,
// adding 2 DB roundtrips (business.findUnique + mpConnection.findUnique) vs the
// previous inline path that passed ctx.bizSnapshot. Result is byte-identical; only
// latency differs. Threading BizSnapshot into the port was rejected because BizSnapshot
// lives in the agent's internal _lib layer and the port must not import from it
// (dependency-inversion violation). The extra roundtrips are acceptable for a read-path
// status check. See engram topic_key "agents/payments-status-seam".

import { z } from "zod/v3";
import { FunctionTool } from "@google/adk";
import { createPaymentsBackend } from "@/lib/mcp/_lib/payments-backend.factory";
import type { BizSnapshot } from "./payments-agent-types";

// At least one of paymentIntentId or customerName required. Name resolves to most recent intent.
// NOTE: Do NOT add `.refine(...)` here — ADK's `isZodObject` detector strictly checks
// `_def.typeName === "ZodObject"`. `.refine()` wraps the schema in `ZodEffects`, ADK
// then ships the raw zod object (with `_def` + `~standard`) to Vertex AI, which rejects
// the request with HTTP 400 ("Unknown name '_def' at function_declarations.parameters")
// — breaking the entire Payments agent for all turns, not just this tool.
// Cross-field requirement (at least one of paymentIntentId or customerName) is enforced
// inside the executor below via the `missing_lookup_key` branch.
const getPaymentStatusParams = z.object({
  paymentIntentId: z.string().optional().describe("The Velora paymentIntentId returned by create_payment_link. Optional when customerName is provided."),
  customerName: z.string().optional().describe("Customer name to look up the most recent open payment intent for. Use when the owner asks by customer name instead of by ID."),
});

export function buildGetPaymentStatusTool(ctx: { businessId: string | null; actorUserId: string | null; turnId: string; bizSnapshot?: BizSnapshot | null }) {
  return new FunctionTool({
    name: "get_payment_status",
    description:
      "Checks the current status of a payment. Accepts a Velora paymentIntentId OR a customer name " +
      "(e.g. 'Juan') — when a name is given, resolves the most recent open payment intent for that customer. " +
      "Returns status: pending | approved | rejected | error.",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ADK ships a nested zod copy with nominally distinct types; the cast happens at the SDK boundary only.
    parameters: getPaymentStatusParams as any,
    execute: async (input) => {
      const raw = input as z.infer<typeof getPaymentStatusParams>;
      if (!ctx.businessId) {
        return { error: "missing_business_context", currency: "ARS" };
      }

      const backend = createPaymentsBackend();
      const result = await backend.getPaymentStatus({
        tenantId: ctx.businessId,
        paymentIntentId: raw.paymentIntentId,
        customerName: raw.customerName,
      });

      // Map adapter domain errors back to the tool's return shape.
      if (result.domainError) {
        switch (result.domainError) {
          case "missing_lookup_key":
            return { error: "missing_lookup_key", message: "Necesito el paymentIntentId o el nombre del cliente.", currency: "ARS" };
          case "customer_not_found":
            return {
              error: "customer_not_found",
              message: `No encontré al cliente "${raw.customerName}". Verificá el nombre o usá el paymentIntentId.`,
              currency: "ARS",
            };
          case "no_payment_intent_found":
            return {
              error: "no_payment_intent_found",
              message: `No encontré ningún cobro para "${raw.customerName}".`,
              currency: "ARS",
            };
          case "payment_intent_not_found":
            return {
              error: "no_payment_intent_found",
              message: "No encontré el cobro indicado.",
              currency: "ARS",
            };
          case "status_lookup_failed":
            return {
              error: "status_lookup_failed",
              paymentIntentId: result.paymentIntentId ?? raw.paymentIntentId,
              currency: "ARS",
            };
        }
      }

      return {
        sandbox: false,
        paymentIntentId: result.paymentIntentId!,
        customerName: raw.customerName ?? null,
        providerRef: result.providerRef ?? null,
        status: result.status!,
        currency: "ARS",
      };
    },
  });
}
