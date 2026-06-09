// intent-kind-to-canonical.ts — Maps each deterministic intent kind to the
// canonical AssistantIntent used by gateIntentByRole. Split from types.ts to
// keep that file within the 300-line contract.

import type { AssistantIntent } from "../types";
import type { DeterministicIntentKind } from "./types";

// Mapea cada kind determinístico al intent canónico del role-contract.
// Lo usa el dispatcher para invocar gateIntentByRole. Si un kind no
// requiere RBAC explícito (ej. invoice/purchase_request manejan auth
// downstream), devuelve null y el dispatcher salta el gate.
export function intentKindToCanonical(kind: DeterministicIntentKind): AssistantIntent | null {
  switch (kind) {
    case "undo": return null; // gateado inline (mensaje custom)
    case "forgot_customer": return "register_sale";
    case "create_customer": return "create_customer";
    case "create_product": return "create_product";
    case "sale_create": return "register_sale";
    case "sale_create_pending_customer": return "register_sale";
    case "sale_create_inline_new_customer": return "register_sale";
    case "sale_send": return "register_sale";
    case "single_price_edit": return "edit_product";
    case "multi_price_edit": return "bulk_price_update";
    case "price_update_clarification": return null; // sólo clarification, no destructiva
    case "invoice": return null; // handler downstream gates
    case "purchase_request": return null; // handler downstream gates
    case "cobro_qr": return null; // handler downstream gates (slice posterior)
    case "stock_query": return null; // read-only, no RBAC (ambos roles pueden consultar stock)
    case "stock_summary": return null; // read-only, no RBAC (general inventory summary)
    case "business_setup_fast_path": return null; // owner-only inline (no DB write, client toggle)
    case "delete_product": return "delete_product";
    case "owner_only_blocked": return null; // gateado inline, mensaje warm reject custom
    case "price_query": return null; // read-only, no RBAC (ambos roles pueden consultar precio/stock)
    case "stock_load_fast_path": return "stock_load"; // employee can stock-load; RBAC checked inline
    case "external_agent_call": return null; // owner-only, gated inline in executor
    case "andreani_fast_path": return null; // owner-only, gated inline in executor
    case "delete_sale_item_escalation": return null; // escalated to owner via permission flow, not RBAC block
    case "payment_link_fast_path": return null; // owner-only, gated inline in executor
    case "payment_link_send": return null; // owner-only, gated inline in executor
    case "payment_link_cancel": return null; // read-only acknowledgement, no mutation
    case "business_postal_reply": return null; // owner-only config write, gated inline in executor
    case "alias_update": return null; // owner-only, gated inline in executor
    case "courier_settings": return null; // owner-only, gated inline in executor
    case "mp_oauth_reconnect": return null; // owner-only, gated inline in executor
    case "service_connect": return null; // owner-only, gated inline in executor
  }
}
