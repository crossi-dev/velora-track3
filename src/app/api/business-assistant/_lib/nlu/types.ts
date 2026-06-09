// NLU layer — discriminated union de intents detectados determinísticamente.
// Mapea texto → intent estructurado. NO ejecuta acciones, NO conoce RBAC.
// El dispatcher consume DeterministicIntent | null: gate → execute.

export interface UndoIntent {
  kind: "undo";
  target: "sale" | "customer" | "stock";
  count: number;
}

export interface ForgotCustomerIntent {
  kind: "forgot_customer";
  saleText: string;
}

export interface CreateCustomerIntent {
  kind: "create_customer";
  // El handler aún necesita correr resolveCustomerCreateRequest contra el
  // texto + (opcionalmente) parsed del LLM. NLU sólo confirma intención.
}

// create_product Fast Path — el detector ya extrajo name + price + stock
// del texto crudo. Bypasses Gemini Pro (~10-18s cross-region) cuando el
// usuario tipea/dicta el patrón canónico ("cargar producto X N unidades P
// pesos"). Si el detector falla (ej. STT mangling, falta de price), el
// dispatcher cae al Slow Path.
export interface CreateProductIntent {
  kind: "create_product";
  name: string;
  price: number;
  stock: number;
  /** Weight per unit in grams. Optional — null means unknown (executor uses 500g estimate). */
  weightGrams: number | null;
}

export interface SaleSendIntent {
  kind: "sale_send";
  matchedProductId: string | null;
  matchedCustomerId: string | null;
  productName: string;
  productAmbiguous: boolean;
  customerAmbiguous: boolean;
  needsLlmFallback: boolean; // true → dispatcher asks LLM to resolve IDs
  qty: number; // extracted from text; defaults to 1 when not stated
  productCandidates?: Array<{ id: string; name: string }>; // picker candidates when product match ambiguous
  customerCandidates?: Array<{ id: string; name: string }>; // picker candidates when customer match ambiguous
}

export interface SinglePriceEditIntent {
  kind: "single_price_edit";
  // payload no requerido — el handler responde con warm reject (RBAC) o
  // delega al modelo para extraer producto+valor (owner path, futuro).
}

export interface MultiPriceEditIntent {
  kind: "multi_price_edit";
  edits: Array<{ productName: string; value: number }>;
  // Names (normalized fragments) that had a price digit but no catalog match.
  // Populated when detectMultiProductPriceEditFull finds partial matches.
  unknownFragments: string[];
}

export interface PriceUpdateClarificationIntent {
  kind: "price_update_clarification";
  // Fallback cuando hay verbos de edición + 'precio' + ≥2 números pero NLU
  // no pudo bindear a productos del catálogo (ej. STT mangleó nombres).
}

export interface InvoiceIntent {
  kind: "invoice";
  // El handler usa el texto + invoiceDirectory directamente. NLU solo
  // marca que es un comando de invoice (open / send / etc).
}

export interface PurchaseRequestIntent {
  kind: "purchase_request";
  // Mismo patrón que invoice — el handler resuelve el subcomando.
}

// Cobro QR — empleado tipea "cobro 5000" / "cobro QR 5000 a Carlos".
// NLU extrae monto y opcionalmente bindea cliente del catálogo. El handler
// downstream crea el PaymentIntent y renderiza el QR (modo "qr") o el
// alias del dueño (modo "alias", slice 2 — "modo informal" sin API MP).
//
// `metodo` discrimina las dos UX:
//   - "qr"    — QR placeholder + monto + botón "Marcar cobrado".
//   - "alias" — alias del dueño en grande + copy-to-clipboard + botón
//               "Marcar cobrado". Si el business no tiene alias seteado,
//               el handler responde con un error chip pidiendo configurarlo.
export type CobroMetodo = "qr" | "alias";

export interface CobroQrIntent {
  kind: "cobro_qr";
  metodo: CobroMetodo;
  monto: number;
  matchedCustomerId: string | null;
  customerName: string | null;
}

// Detectado deterministicamente para empleado cuando el texto expresa
// un intent owner-only con suficiente claridad. El dispatcher lo usa
// para emitir el warm reject canónico SIN llamar al LLM (evita
// alucinaciones del estilo "Producto borrado del catálogo.").
export interface OwnerOnlyBlockedIntent {
  kind: "owner_only_blocked";
  blockedIntent: import("../types").AssistantIntent;
}

// delete_sale_item_escalation — empleado pide sacar un ítem de la venta en curso.
// Detectado antes de owner_only_blocked; escala al dueño via B1 (no warm reject).
export interface DeleteSaleItemEscalationIntent {
  kind: "delete_sale_item_escalation";
  rawText: string;
}

// stock_query — read-only query "¿cuánto stock tengo de X?". Bypassa
// Gemini Pro (~8-15s cross-region) cuando el owner dispara la pregunta
// canónica. El detector extrae el fragmento de producto; el executor
// resuelve contra el catálogo con findProductInfoMatch. Sin RBAC (lectura).
export interface StockQueryIntent {
  kind: "stock_query";
  productText: string;
}

// stock_summary — general inventory summary ("cuánto stock tengo", "ver stock",
// "cómo está el stock"). Bypasses the Supervisor LLM which misinterprets "stock"
// as a product name. Executor calls buildInventorySummaryAnswer directly.
export interface StockSummaryIntent {
  kind: "stock_summary";
}

// business_setup Fast Path — comandos tipo Settings ("cambiá el idioma a
// español", "poné la moneda en dólares") que NO requieren razonamiento del
// LLM. Smoke turn 8 medía 27s end-to-end vía Gemini Pro (cross-region tail);
// el detector lo deja en sub-100ms. El executor emite un answer determinístico
// + hint al toggle en Settings; no se hace DB write — `language` y `currency`
// son toggles client-side (localStorage `velora-lang`, cookie `NEXT_LOCALE`),
// no campos persistidos del Business.
export interface BusinessSetupFastPathIntent {
  kind: "business_setup_fast_path";
  field: "language" | "currency";
  value: "es-AR" | "en" | "ARS" | "USD";
  label: string;
}

// sale_create Fast Path — PLAIN sale create (sin auto-send WhatsApp).
// Bypasses Gemini Pro (~30s cross-region tail) cuando producto + cliente
// del catálogo se resuelven determinísticamente. Companion al sale_send:
// si el texto trae keyword de envío, lo agarra sale_send (handler distinto
// con flag autoSend=true). Si no, esto. Conservative: si producto o cliente
// no resuelven sin ambigüedad, cae al LLM.
export interface SaleCreateIntent {
  kind: "sale_create";
  matchedProductId: string;
  matchedCustomerId: string;
  productName: string;
  customerName: string;
  qty: number;
  unitPrice: number | null; // null = usar precio del catálogo
}

// delete_product Fast Path — "borrá el producto X". Bypasses Gemini Pro
// (~29s cross-region tail) cuando el nombre del producto resuelve sin
// ambigüedad contra el catálogo. El detector extrae sólo el fragmento
// (texto); el executor resuelve contra productInfoDirectory con
// findProductInfoMatch y emite la confirmation card canónica.
export interface DeleteProductIntent {
  kind: "delete_product";
  productText: string;
}

// stock_load Fast Path — deterministic extraction for "llegaron N X a $Y" /
// "entraron N X a $Y" etc. Bypasses Gemini Flash for high-frequency employee
// stock-ingress inputs. Wired into detect.ts 2026-05-10.
export interface StockLoadIntent {
  kind: "stock_load_fast_path";
  quantity: number;
  productHint: string;
  unitCost: number | null;
}

// price_query Fast Path — promoted from post-LLM rescue (productQueryRescueStage)
// to pre-LLM detection. Deterministic detector handles "¿cuánto sale la coca?" /
// "precio del pan" without any Gemini call. Confirmed 4/5 parse fail rate
// when these queries hit the model (isolate-retry 2026-05-10).
export interface PriceQueryIntent {
  kind: "price_query";
  queryKind: "price" | "stock";
  productText: string;
}

// sale_create_pending_customer — product resolved, customer NOT identified.
// Business has customers (>0) but none matched → show picker chips.
// (Empty catalog → fall through to LLM which defaults to Consumidor Final.)
export interface SaleCreatePendingCustomerIntent {
  kind: "sale_create_pending_customer";
  matchedProductId: string;
  productName: string;
  qty: number;
  unitPrice: number | null;
}
// Sibling-module re-exports to keep this file within the 300-line contract.
import type { SaleCreateInlineNewCustomerIntent as SaleCreateInlineNewCustomerIntentBase } from "./sale-create-inline-customer-intent";
export type SaleCreateInlineNewCustomerIntent = SaleCreateInlineNewCustomerIntentBase;
import type { AndreaniIntent as AndreaniIntentBase } from "./andreani-fast-path";
export type AndreaniIntent = AndreaniIntentBase;

// external_agent_call Fast Path — owner invokes a trusted A2A peer directly
// from chat: "pedile precio a Distribuidora Mendoza de 50 cajas Quilmes".
// Detector: nlu/external-agent-fast-path.ts. Executor resolves the peer domain
// from TrustedPeerAgent table and calls /api/peers/call (Supervisor-signed A2A).
export interface ExternalAgentCallIntent {
  kind: "external_agent_call";
  peerHint: string;
  skillId: "wholesale.price.quote" | "wholesale.order.create";
  productText: string;
  qty: number | null;
}

// DeleteCustomerIntent / UpdateBusinessRuleIntent: reverted to Slow Path
// (LLM). See 2026-05-10 decision note in git history.

// payment_link_fast_path — owner requests a payment link from the Payments
// Agent. Fires before Supervisor LLM so the LLM cannot answer directly.
// Root cause fix 2026-05-18: dispatch to /api/agents/payments/jsonrpc.
export interface PaymentLinkFastPathIntent {
  kind: "payment_link_fast_path";
  rawText: string;
}

// payment_link_send — owner taps the "📲 Enviar a {Name}" chip after reviewing
// the payment-link card. Value: "enviar_link_pago|{phone}|{paymentIntentId}".
// Executor resolves checkoutUrl from PaymentIntent DB row. Owner-only.
export interface PaymentLinkSendIntent {
  kind: "payment_link_send";
  phone: string;
  paymentIntentId: string; // cuid — executor looks up checkoutUrl from this
}

// payment_link_cancel — owner taps the "Cancelar" chip after reviewing the
// payment-link card. Value: "cancelar_link_pago". No side effects — just
// acknowledges that the link was NOT sent.
export interface PaymentLinkCancelIntent {
  kind: "payment_link_cancel";
}

// business_postal_reply — owner replies with a postal code after Velora asked.
// isCanonical=true  → "código postal de tu negocio" marker → write to Business.postalCode.
// isCanonical=false → destination-CP marker → write to Customer.postalCode.
// Owner-only (gated in detect).
export interface BusinessPostalReplyIntent {
  kind: "business_postal_reply";
  postalCode: string;
  isCanonical: boolean;
  matchedMarker: string;
}

// Credential-update intents (post-onboarding) — re-exported from credential-update-intent.ts.
import type { AliasUpdateIntent, CourierSettingsIntent, MpOAuthReconnectIntent, ServiceConnectIntent } from "./credential-update-intent";
export type { AliasUpdateIntent, CourierSettingsIntent, MpOAuthReconnectIntent, ServiceConnectIntent };

// intentKindToCanonical moved to intent-kind-to-canonical.ts to keep this
// file within the 300-line contract. Re-exported here for callers.
export { intentKindToCanonical } from "./intent-kind-to-canonical";

export type DeterministicIntent =
  | UndoIntent
  | ForgotCustomerIntent
  | CreateCustomerIntent
  | CreateProductIntent
  | SaleCreateIntent
  | SaleCreatePendingCustomerIntent
  | SaleCreateInlineNewCustomerIntent
  | SaleSendIntent
  | SinglePriceEditIntent
  | MultiPriceEditIntent
  | PriceUpdateClarificationIntent
  | InvoiceIntent
  | PurchaseRequestIntent
  | CobroQrIntent
  | StockQueryIntent
  | StockSummaryIntent
  | BusinessSetupFastPathIntent
  | DeleteProductIntent
  | OwnerOnlyBlockedIntent
  | PriceQueryIntent
  | StockLoadIntent
  | ExternalAgentCallIntent
  | AndreaniIntent
  | DeleteSaleItemEscalationIntent
  | PaymentLinkFastPathIntent
  | PaymentLinkSendIntent
  | PaymentLinkCancelIntent
  | BusinessPostalReplyIntent
  | AliasUpdateIntent
  | CourierSettingsIntent
  | MpOAuthReconnectIntent
  | ServiceConnectIntent;

export type DeterministicIntentKind = DeterministicIntent["kind"];
