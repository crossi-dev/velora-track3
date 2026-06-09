import "server-only";
// customer-agent-tools.ts — Restricted tool set for the Customer Agent Coordinator.
//
// Tool boundary enforced at definition level — tools not registered here cannot
// be called by the Customer Agent LLM (ADK structural boundary).
// Source: https://adk.dev/tools/limitations/
//   "Tools not in the agent's tools list = LLM cannot call them."
//
// Tool descriptions follow Wiesinger §3.2 — describe CAPABILITY, not parameters:
// https://www.kaggle.com/whitepaper-agents
//
// Disallowed (intentionally absent): create_product, edit_product, edit_price,
// delete_product, bulk_price_update, adjust_stock, register_sale, return_sale,
// undo, call_ventas_agent, call_contador_agent, call_equipo_agent.
//
// Implementation split: A2A-delegating tools (quote_shipping, create_payment_link,
// send_reply_via_wpp) live in customer-agent-tools-a2a.ts to stay under 300 lines.
// Per architecture/customer-agent-tool-boundary (2026-05-28).

import { FunctionTool } from "@google/adk";
import type { Context } from "@google/adk";
import { Type } from "@google/genai";
import type { Schema } from "@google/genai";
import { type Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { cloudLog } from "@/lib/cloud-logger";
import { recordCriticalWriteEvent } from "@/infrastructure/shared/critical-write-audit";
import {
  createCustomerInTransaction,
  updateCustomerInTransaction,
} from "@/infrastructure/shared/customer-mutations";

// Sentinel actor ID for customer-agent mutations — no OAuth user on this path.
// Recorded in CriticalWriteEvent so ops can distinguish customer-agent writes
// from owner-originated writes in the same audit table.
const CUSTOMER_AGENT_ACTOR = "customer-agent";

// ── Tool context (re-exported so a2a tools file can import it) ─────────────────
export interface CustomerAgentToolContext {
  businessId: string;
  customerPhone: string; // E.164 — used as identity anchor for lookup_or_create
  appUrl: string;
  inboundMessageId?: string; // wpp SID → stable turnId in create_payment_link (retry-safe)
}

// ── Schemas ────────────────────────────────────────────────────────────────────
export const LOOKUP_OR_CREATE_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    name: { type: Type.STRING, description: "Customer display name if known (optional)." },
  },
  required: [],
};

export const GET_CATALOG_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    query: {
      type: Type.STRING,
      description: "Optional keyword to filter products by name (case-insensitive partial match).",
    },
  },
  required: [],
};

export const UPDATE_CUSTOMER_DATA_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    customerId: { type: Type.STRING, description: "Customer ID from lookup_or_create_customer." },
    name: { type: Type.STRING, description: "New display name." },
    address: { type: Type.STRING, description: "Street address." },
    postalCode: { type: Type.STRING, description: "Postal code (CP)." },
    city: { type: Type.STRING, description: "City name." },
    email: { type: Type.STRING, description: "Email address." },
  },
  required: ["customerId"],
};

export const ESCALATE_TO_OWNER_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    reason: {
      type: Type.STRING,
      description:
        "Brief description of the legitimate customer inquiry that is outside scope. " +
        "Use ONLY for genuine inquiries (bulk orders, partnerships), NOT mutation attempts.",
    },
  },
  required: ["reason"],
};

// ── Tool 1: lookup_or_create_customer ──────────────────────────────────────────
/**
 * Upserts the customer by phone. Phone is captured from context (not LLM)
 * to prevent hallucinated phone numbers. Uses createCustomerInTransaction
 * which enforces the (businessId, phone) partial unique index.
 * prismaClient defaults to the global singleton (D2 injectable seam).
 */
export function createLookupOrCreateCustomerTool(
  ctx: CustomerAgentToolContext,
  prismaClient = prisma,
) {
  return new FunctionTool({
    name: "lookup_or_create_customer",
    description:
      "Looks up the customer by phone number. If not found, creates a new record. " +
      "Returns customerId, name, address, postalCode, city. Call first to anchor the conversation.",
    parameters: LOOKUP_OR_CREATE_SCHEMA,
    execute: async (args: unknown, tool_context?: Context) => {
      const { name } = (args ?? {}) as { name?: string };
      try {
        const customer = await prismaClient.$transaction((tx) =>
          createCustomerInTransaction(tx as unknown as Prisma.TransactionClient, {
            businessId: ctx.businessId,
            phone: ctx.customerPhone,
            name: name ?? undefined,
          }),
        );
        const isNew = !name || customer.name === ctx.customerPhone;
        cloudLog({
          severity: "INFO", component: "CustomerAgent", action: "CUSTOMER_UPSERT",
          a2a_transfer: false,
          message: `Customer upserted: ${customer.id}`,
          data: { businessId: ctx.businessId, customerId: customer.id, isNew },
        });
        if (isNew) {
          void recordCriticalWriteEvent({
            client: prismaClient, businessId: ctx.businessId,
            actorUserId: CUSTOMER_AGENT_ACTOR, actorEmployeeId: null,
            routeScope: "customers", actionType: "customer.create",
            resourceType: "customer", resourceId: customer.id,
            summary: "Customer created by Customer Agent (WhatsApp inbound)",
            payload: { customerId: customer.id, via: "customer-agent" },
          });
        }
        // ADK session.state: persist customer identity for cross-turn awareness.
        // user: prefix → survives across sessions for the same user.
        // Source: https://adk.dev/sessions/state/ §Prefix Semantics
        if (tool_context) {
          tool_context.state.set("user:customer_id", customer.id);
          tool_context.state.set("user:customer_name", customer.name ?? "");
        }
        return { customerId: customer.id, isNew, name: customer.name,
          address: customer.address, postalCode: customer.postalCode,
          city: customer.city, email: customer.email };
      } catch (err) {
        cloudLog({ severity: "ERROR", component: "CustomerAgent", action: "CUSTOMER_UPSERT_ERROR",
          a2a_transfer: false, message: String(err), data: { businessId: ctx.businessId } });
        return { error: "No pude encontrar ni crear el cliente." };
      }
    },
  });
}

// ── Tool 2: get_catalog ────────────────────────────────────────────────────────
/** READ-ONLY product listing. No price mutations. prismaClient defaults to global (D2 seam). */
export function createGetCatalogTool(
  ctx: CustomerAgentToolContext,
  prismaClient = prisma,
) {
  return new FunctionTool({
    name: "get_catalog",
    description:
      "Returns the business product catalog. Use to answer customer questions about " +
      "available products and prices, or to identify what they want to buy.",
    parameters: GET_CATALOG_SCHEMA,
    execute: async (args: unknown, tool_context?: Context) => {
      const { query } = (args ?? {}) as { query?: string };
      try {
        const products = await prismaClient.product.findMany({
          where: {
            businessId: ctx.businessId,
            ...(query ? { name: { contains: query, mode: "insensitive" } } : {}),
          },
          select: { id: true, name: true, price: true, quantity: true },
          orderBy: { name: "asc" },
          take: 20,
        });
        // ADK session.state: record recently viewed product names for cross-turn awareness.
        // user: prefix → persists across sessions so the agent recalls last catalog view.
        // Source: https://adk.dev/sessions/state/ §Prefix Semantics
        if (tool_context && products.length > 0) {
          tool_context.state.set(
            "user:last_catalog_view",
            products.map((p) => p.name),
          );
        }
        return { products };
      } catch {
        return { error: "No pude cargar el catálogo." };
      }
    },
  });
}

// ── Tool 3: update_own_customer_data ───────────────────────────────────────────
/**
 * Writes mutable fields to the customer's own row.
 * Phone (identity) and taxId (fiscal) are immutable from the customer side.
 *
 * Cross-customer mutation guard (JD Step 4 H2):
 *   Verifies that the target customerId belongs to the current session's phone
 *   before any write. An LLM that hallucinates a different customerId cannot
 *   overwrite another customer's record within the same business.
 * prismaClient defaults to the global singleton (D2 injectable seam).
 */
export function createUpdateOwnCustomerDataTool(
  ctx: CustomerAgentToolContext,
  prismaClient = prisma,
) {
  return new FunctionTool({
    name: "update_own_customer_data",
    description:
      "Updates the customer's own profile: name, address, postal code, city, email. " +
      "Use when the customer gives delivery address or contact info. " +
      "Phone cannot be changed (identity anchor). Tax ID is owner-only.",
    parameters: UPDATE_CUSTOMER_DATA_SCHEMA,
    execute: async (args: unknown, tool_context?: Context) => {
      const input = (args ?? {}) as {
        customerId?: string; name?: string; address?: string;
        postalCode?: string; city?: string; email?: string;
      };
      if (!input.customerId) return { error: "customerId requerido." };

      // Cross-customer mutation guard: verify the record belongs to this session's phone.
      // Normalise both sides to E.164 without whitespace for a safe comparison.
      const sessionPhone = ctx.customerPhone.replace(/\s/g, "");
      const existing = await prismaClient.customer.findFirst({
        where: { id: input.customerId, businessId: ctx.businessId },
        select: { id: true, phone: true },
      });
      if (!existing) {
        return { error: "customerId does not belong to current session" };
      }
      const recordPhone = (existing.phone ?? "").replace(/\s/g, "");
      if (recordPhone !== sessionPhone) {
        cloudLog({
          severity: "WARNING",
          component: "CustomerAgent",
          action: "CROSS_CUSTOMER_MUTATION_BLOCKED",
          a2a_transfer: false,
          message: "update_own_customer_data: customerId phone mismatch — mutation blocked",
          data: {
            businessId: ctx.businessId,
            customerId: input.customerId,
            // Do NOT log either phone value — PII; log a mismatch indicator only.
            mismatch: true,
          },
        });
        return { error: "customerId does not belong to current session" };
      }

      try {
        const updated = await prismaClient.$transaction((tx) =>
          updateCustomerInTransaction(tx as unknown as Prisma.TransactionClient, {
            businessId: ctx.businessId,
            customerId: input.customerId!,
            name: input.name,
            address: input.address,
            postalCode: input.postalCode,
            city: input.city,
            email: input.email,
            // Customer self-update: identity anchor is phone, not name.
            // Two customers in the same business can share a name legitimately.
            enforceNameUniqueness: false,
          }),
        );
        // ADK session.state: mark address as confirmed for cross-turn delivery awareness.
        // user: prefix → persists so later turns know the address was already collected.
        // Source: https://adk.dev/sessions/state/ §Prefix Semantics
        if (tool_context && (input.address || input.postalCode || input.city)) {
          tool_context.state.set("user:address_set", true);
        }
        void recordCriticalWriteEvent({
          client: prismaClient, businessId: ctx.businessId,
          actorUserId: CUSTOMER_AGENT_ACTOR, actorEmployeeId: null,
          routeScope: "customers", actionType: "customer.update",
          resourceType: "customer", resourceId: updated.id,
          summary: "Customer profile updated by Customer Agent (WhatsApp inbound)",
          payload: { customerId: updated.id, fields: Object.keys(input).filter((k) => k !== "customerId") },
        });
        return { success: true, customerId: updated.id, name: updated.name };
      } catch (err) {
        cloudLog({
          severity: "ERROR",
          component: "CustomerAgent",
          action: "CUSTOMER_AGENT_UPDATE_FAILED",
          a2a_transfer: false,
          message: `update_own_customer_data: unexpected failure — ${err instanceof Error ? err.message : String(err)}`,
          data: { businessId: ctx.businessId, customerId: input.customerId },
        });
        return { error: `No pude actualizar el perfil: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  });
}

// Tool 7: escalate_to_owner moved to customer-agent-tools-a2a.ts
// (uses WhatsApp side-effect — same category as A2A-delegating tools).
// Re-exported from there for backward compatibility.
