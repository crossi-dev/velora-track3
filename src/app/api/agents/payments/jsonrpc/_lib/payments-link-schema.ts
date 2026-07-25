// create_payment_link tool parameter schema and input type.
// Extracted from payments-agent-tools.ts to stay under the 300-line limit.

import { Type } from "@google/genai";
import type { Schema } from "@google/genai";

// Raw @google/genai Schema — same pattern as other Payments ADK tools.
// Zod v3 produces exclusiveMinimum:true (Draft 4 boolean) which Vertex AI's
// Schema validator rejects, silently dropping the entire function declaration list.
export const createPaymentLinkParams: Schema = {
  type: Type.OBJECT,
  properties: {
    customerId: {
      type: Type.STRING,
      description:
        "Canonical customer ID in Velora's DB. " +
        "The Supervisor must resolve this from the customer name BEFORE delegating to the Payments Agent.",
    },
    items: {
      type: Type.ARRAY,
      description: "Products included in the sale. At least one item required.",
      minItems: "1",
      items: {
        type: Type.OBJECT,
        properties: {
          productId: {
            type: Type.STRING,
            description: "Canonical product ID in Velora's DB. Must come from a prior catalog lookup — never invent IDs.",
          },
          quantity: {
            type: Type.INTEGER,
            description: "Quantity sold. Must be a positive integer.",
          },
          unitPriceOverride: {
            type: Type.NUMBER,
            description:
              "Unit price override. Use ONLY when the owner explicitly stated a price " +
              "different from the catalog. Omit to use the DB catalog price.",
          },
        },
        required: ["productId", "quantity"],
      },
    },
    description: {
      type: Type.STRING,
      description: "Payment description shown to the customer (e.g. 'Venta Velora - 3 filtros de aire')",
    },
    shippingRequired: {
      type: Type.BOOLEAN,
      description: "Set true when the owner requests a payment link that includes shipping costs.",
    },
    destinationPostalCode: {
      type: Type.STRING,
      description: "Destination postal code (4-5 digits). Required when shippingRequired=true and the customer has no saved postal code.",
    },
    destinationAddress: {
      type: Type.STRING,
      description: "Street address of the recipient. Used for shipment.create snapshot.",
    },
    preQuotedShippingCostARS: {
      type: Type.NUMBER,
      description:
        "Pre-quoted shipping cost in ARS. When present (>0), the tool uses this value directly " +
        "and skips the Logística re-quote. Pass through from the Customer Agent when the shipping " +
        "was already quoted upstream (indicated by 'preQuotedShippingCostARS: N' in the input). " +
        "Set shippingRequired=true alongside this field.",
    },
  },
  required: ["customerId", "items", "description"],
};

/** Runtime input shape — mirrors the Schema fields above. */
export type CreatePaymentLinkInput = {
  customerId: string;
  items: Array<{ productId: string; quantity: number; unitPriceOverride?: number }>;
  description: string;
  shippingRequired?: boolean;
  destinationPostalCode?: string;
  destinationAddress?: string;
  preQuotedShippingCostARS?: number;
};
