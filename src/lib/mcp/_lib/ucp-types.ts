// src/lib/mcp/_lib/ucp-types.ts — Canonical UCP Order types for Velora MCP widgets.
//
// Single source of truth for the UCP Order shape used by the three Velora payment
// widgets (cobro-status, pending-orders, delivery-receipt) and their corresponding
// render tools.  Importing from here avoids silent per-file drift when the spec
// evolves.
//
// UCP Order spec: https://ucp.dev/latest/specification/order/
//
// Field notes:
//   UCPLineItem.status — strict union of the three values Velora maps:
//     "processing"  → awaiting payment  (pending cobro)
//     "fulfilled"   → payment received  (confirmed cobro / delivery)
//     "removed"     → expired or cancelled link
//   UCPTotal.type — Velora only ever writes "total"; kept as literal.
//   UCPOrder.currency — Velora only ever writes "ARS"; kept as literal.
//   UCPFulfillment / UCPFulfillmentEvent — used exclusively by delivery-receipt;
//     exported here so the type lives in one place.
//   UCPOrder.fulfillment is optional so cobro-status and pending-orders can use
//     the same UCPOrder type without supplying the field.

export type UCPLineStatus = "processing" | "fulfilled" | "removed";

export interface UCPAmount {
  /** Integer minor units (centavos for ARS). */
  amount: number;
  /** ISO 4217 currency code (e.g. "ARS"). */
  currency: string;
}

export interface UCPLineItem {
  id: string;
  item: { id: string; title: string; price: UCPAmount };
  quantity: number;
  status: UCPLineStatus;
}

export interface UCPTotal {
  type: "total";
  amount: number;
}

export interface UCPFulfillmentEvent {
  id: string;
  occurred_at: string;  // ISO 8601
  type: "shipment";
  tracking_number: string;
  carrier: string;
  description: string;
}

export interface UCPFulfillment {
  expectations: [];  // empty — Velora does not model delivery windows
  events: UCPFulfillmentEvent[];
}

export interface UCPOrder {
  id: string;
  line_items: UCPLineItem[];
  totals: UCPTotal[];
  /** Velora always emits "ARS". */
  currency: "ARS";
  permalink_url?: string;
  /** Present only in delivery-receipt orders (step 5, commerce flow). */
  fulfillment?: UCPFulfillment;
}
