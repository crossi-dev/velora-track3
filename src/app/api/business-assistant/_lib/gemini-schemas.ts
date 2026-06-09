// Vertex AI response schemas for Companion (Flash) and Supervisor (Pro).
// Extracted from gemini-client.ts to stay within the 300-line file limit.
// Keep CANONICAL_SUPERVISOR_INTENTS in sync with:
//   - supervisor/_lib/supervisor-schema.ts CANONICAL_INTENTS
//   - business-assistant/_lib/types.ts AssistantIntent

import { Type } from "@google/genai";

// Mirror of AssistantIntent — Companion (Flash) intents only.
// Enforced at model level so the model cannot hallucinate intent strings.
export const EMPLOYEE_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  required: ["intent", "answer", "confidence"],
  properties: {
    intent: {
      type: Type.STRING,
      enum: [
        "answer", "register_sale", "register_movement", "adjust_stock",
        "edit_product", "delete_product", "create_supplier", "edit_supplier", "delete_supplier",
        "create_customer", "edit_customer", "delete_customer", "stock_load", "business_query",
        "bulk_price_update", "report_event", "create_purchase_request",
        "create_product", "create_budget", "return_sale", "cobro_qr",
      ],
    },
    answer: { type: Type.STRING },
    confidence: { type: Type.NUMBER },
    matchedProductId: { type: Type.STRING },
    matchedCustomerId: { type: Type.STRING },
    autoSend: { type: Type.BOOLEAN },
    product: {
      type: Type.OBJECT,
      properties: { name: { type: Type.STRING } },
    },
    customer: {
      type: Type.OBJECT,
      properties: {
        name: { type: Type.STRING },
        phone: { type: Type.STRING },
        email: { type: Type.STRING },
        taxId: { type: Type.STRING },
      },
    },
    clarification: {
      type: Type.OBJECT,
      properties: {
        needed: { type: Type.BOOLEAN },
        question: { type: Type.STRING },
        bestGuess: { type: Type.STRING },
      },
    },
    stockDraft: {
      type: Type.OBJECT,
      properties: {
        itemName: { type: Type.STRING },
        quantity: { type: Type.NUMBER },
        unitPrice: { type: Type.NUMBER },
        supplierName: { type: Type.STRING },
      },
    },
    stockDrafts: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          itemName: { type: Type.STRING },
          quantity: { type: Type.NUMBER },
          unitPrice: { type: Type.NUMBER },
        },
      },
    },
    saleDraft: {
      type: Type.OBJECT,
      properties: {
        customerName: { type: Type.STRING },
        items: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              productName: { type: Type.STRING },
              quantity: { type: Type.NUMBER },
              unitPrice: { type: Type.NUMBER },
            },
          },
        },
      },
    },
    eventReport: {
      type: Type.OBJECT,
      properties: {
        eventType: { type: Type.STRING, enum: ["rotura", "incidente", "stock_aviso", "queja_cliente"] },
        details: { type: Type.STRING },
        productName: { type: Type.STRING },
      },
    },
    purchaseRequestDraft: {
      type: Type.OBJECT,
      properties: {
        supplierName: { type: Type.STRING },
        items: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              itemName: { type: Type.STRING },
              quantity: { type: Type.NUMBER },
              unitPrice: { type: Type.NUMBER },
            },
          },
        },
      },
    },
  },
};

// Supervisor (Pro) response schema — enforced at model level.
// actions[].intent is constrained to CANONICAL_INTENTS so hallucinated
// intent strings are rejected before reaching the Zod post-hoc guard.
// actions[].data is left open (no sub-schema) because each intent has a
// different payload shape.
export const SUPERVISOR_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  required: ["kind", "answer"],
  properties: {
    kind: { type: Type.STRING, enum: ["actions", "clarification", "answer", "notification"] },
    answer: { type: Type.STRING },
    actions: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          intent: {
            type: Type.STRING,
            // Mirror of CANONICAL_INTENTS in supervisor/_lib/supervisor-schema.ts.
            // Keep in sync when adding new intents.
            enum: [
              // Slimmed 2026-05-25 — supervisor delegates operational intents to
              // sub-agents via call_*_agent (Pattern C). Removed entries are
              // either encajonado (create_budget, create_employee, reset_employee_pin,
              // get_employee_credentials, broadcast_employees, call_marketplace_agent,
              // call_equipo_agent) or migrated to sub-agents (register_sale,
              // create_product, edit_product, delete_product, bulk_price_update,
              // adjust_stock, stock_load, register_movement, create_customer,
              // edit_customer, create_supplier, edit_supplier, delete_supplier,
              // return_sale, create_purchase_request, business_query, report_event).
              // CANONICAL_INTENTS in supervisor-schema.ts keeps the wider Zod union
              // for backward-compat in case the LLM emits a legacy intent string.
              "answer",
              "create_business_rule",
              "update_business_rule",
              "delete_business_rule",
              "create_delegation_policy",
              "update_delegation_policy",
              "delete_delegation_policy",
              "call_contador_agent",
              "call_ventas_agent",
              "call_payments_agent",
              "call_logistica_agent",
              "update_business_setup",
            ],
          },
          data: { type: Type.OBJECT },
          summary: { type: Type.STRING },
        },
      },
    },
    clarification: {
      type: Type.OBJECT,
      properties: {
        question: { type: Type.STRING },
        context: { type: Type.STRING },
      },
    },
    notification: {
      type: Type.OBJECT,
      properties: {
        level: { type: Type.STRING, enum: ["now", "daily", "drop"] },
        title: { type: Type.STRING },
        body: { type: Type.STRING },
        reason: { type: Type.STRING },
      },
    },
  },
};
