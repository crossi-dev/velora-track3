// src/lib/mcp/_lib/payments-backend.port.ts — Backend-agnostic port for payments MCP tools.
//
// Decouples the three payments tools from Velora's concrete MercadoPago + PaymentIntent layer.
// A future adapter (e.g. a different payment provider) implements this interface
// and requires ZERO changes to payments-tools.ts or the MCP server.
//
// Design mirrors catalog-backend.port.ts / fiscal-backend.port.ts:
//   port (this file) → adapter (velora-payments.adapter.ts) → factory (payments-backend.factory.ts)
//
// tenantId is opaque here — the Velora adapter maps it to businessId internally
// so the port name doesn't hard-wire Velora's domain vocabulary.
//
// Input/output types are inlined from the handler signatures in payments-tools.ts.
// They are intentionally narrow (tool-contract shapes) — not the
// full domain types. The port is a seam, not a full domain model.
//
// HARD CONSTRAINTS (money path):
//   - getMpTokenForBusiness, PaymentProviderAdapter, and all idempotency are INTERNAL to
//     the Velora adapter — they must NOT be referenced here or in any other adapter.
//   - The MP API call logic is UNTOUCHED inside the adapter; this port just declares
//     the I/O contract.

import type { VeloraPaymentStatus } from "@/app/api/integrations/mp/_lib/mp-status-mapping";
import type { ResolveWizardPrefillInput, ResolveWizardPrefillResult } from "./payments-backend-wizard.port";
import type { ListPendingOrdersInput, PendingOrderItem, PendingOrder } from "./payments-backend-orders.port";

// ── mp_create_preference ──────────────────────────────────────────────────────

export interface CreatePreferenceInput {
  tenantId: string;
  amountARS: number;
  description: string;
  /** Caller-supplied reference. When omitted the adapter generates a UUID. */
  externalReference?: string;
}

export interface CreatePreferenceOutput {
  /**
   * Sentinel string when the MP token is absent/expired/broken, or null on infra failure.
   * The adapter surfaces these rather than throwing so the tool handler can build
   * structured isError responses instead of catching untyped exceptions.
   */
  tokenError?: "NOT_CONNECTED" | "EXPIRED" | "DECRYPT_ERROR" | "UNKNOWN";
  /** Defined only when tokenError is absent. */
  preferenceId?: string;
  checkoutUrl?: string;
  /**
   * Bare reference — callers pass this to getMpPaymentStatus.
   * The adapter stores `${businessId}:${reference}` in MP; this is the bare half.
   */
  paymentReference?: string;
  /** Defined only when the MP API itself returns an error after token resolution. */
  error?: string;
}

// ── mp_payment_status ─────────────────────────────────────────────────────────

export interface GetMpPaymentStatusInput {
  tenantId: string;
  /** Bare paymentReference returned by createPreference — NOT pre-prefixed. */
  paymentReference: string;
}

export interface GetMpPaymentStatusOutput {
  /** Defined when token resolution failed. */
  tokenError?: "NOT_CONNECTED" | "EXPIRED" | "DECRYPT_ERROR" | "UNKNOWN";
  /** Velora-normalised status. */
  status?: VeloraPaymentStatus;
  paymentId?: string | null;
  /** Defined when the MP status search itself failed (transient). */
  mpUnavailable?: boolean;
}

// ── get_payment_intent_status ─────────────────────────────────────────────────

export interface GetPaymentStatusInput {
  tenantId: string;
  paymentIntentId?: string;
  customerName?: string;
}

export interface GetPaymentStatusOutput {
  /** Defined when a domain pre-check fails. */
  domainError?: "missing_lookup_key" | "payment_intent_not_found" | "customer_not_found" | "no_payment_intent_found" | "status_lookup_failed";
  errorMessage?: string;
  /** Defined on success. */
  paymentIntentId?: string;
  status?: string;
  providerRef?: string | null;
}

// ── listPendingOrders — types extracted to keep file under 300 lines ──────────
export type { ListPendingOrdersInput, PendingOrderItem, PendingOrder } from "./payments-backend-orders.port";

// ── getCobroDetail ────────────────────────────────────────────────────────────

export type CobroEstado = "pending" | "confirmed" | "expired" | "cancelled";

export interface GetCobroDetailInput {
  tenantId: string;
  /** Resolve by exact PaymentIntent id when provided. */
  paymentIntentId?: string;
  /**
   * Resolve by most-recent PaymentIntent for this customer name (fuzzy match).
   * Used when paymentIntentId is absent. Same resolution as getPaymentStatus.
   */
  customerName?: string;
}

/**
 * Detail shape for a single cobro displayed by the open_cobro_status widget.
 * customerName and createdAt are Velora display extensions alongside the UCP Order.
 */
export interface CobroDetail {
  id: string;
  estado: CobroEstado;
  customerName: string;
  items: PendingOrderItem[]; // reuse existing item shape
  totalARS: number;          // ARS pesos (not minor units)
  createdAt: Date;
  confirmedAt: Date | null;
  checkoutUrl: string | null;
}

// ── getDeliveryReceipt ────────────────────────────────────────────────────────

export interface GetDeliveryReceiptInput {
  tenantId: string;
  /** Resolve via PaymentIntent id (PI → Sale → invoice + shipment). */
  paymentIntentId?: string;
  /** Resolve directly by Sale id. */
  saleId?: string;
  /**
   * Resolve by most-recent confirmed PI for this customer name (fuzzy match).
   * Same resolution as getCobroDetail. Used when neither id is provided.
   */
  customerName?: string;
}

/**
 * Comprobante / factura block.
 * kind="factura"  → real ARCA/AFIP invoice with a CAE code.
 * kind="comprobante" → comprobante simple de venta (no CAE, or no invoice row at all).
 * AFIP-flexible: never assume a CAE exists.
 */
export interface DeliveryComprobante {
  kind: "factura" | "comprobante";
  /** Display label shown to the customer (e.g. "Factura B", "Comprobante de venta"). */
  label: string;
  /** AFIP-formatted number "PPPP-NNNNNNNN" for facturas; Invoice.invoiceNumber for comprobantes. */
  number?: string;
  /**
   * Fiscal QR URL (fiscalQrUrl from Invoice) when available.
   * NOT a signed PDF URL (those expire). Only set for real ARCA facturas.
   */
  pdfUrl?: string;
}

/**
 * Envío / shipment block.
 * Sourced from AndreaniShipment or OcaShipment (whichever has a row for the saleId).
 * null when no shipment row exists → honest "Retiro en local / sin envío" state.
 */
export interface DeliveryEnvio {
  /** "Andreani" or "OCA" — carrier name resolved from the concrete table used. */
  carrier: string;
  /** trackingNumber from the concrete shipment table. */
  tracking?: string;
  /** status from the concrete shipment table (e.g. "created", "in_transit", "delivered"). */
  status: string;
}

/**
 * Full delivery receipt returned by getDeliveryReceipt.
 * Velora display extensions (not UCP Order fields):
 *   customerName, customerPhone, comprobante, envio.
 * UCP fulfillment mapping:
 *   envio → fulfillment.events[] when present (UCP spec verified: ucp.dev/latest/specification/order/).
 *   fulfillment.events[].carrier, tracking_number, tracking_url, occurred_at, type, description.
 */
export interface DeliveryReceipt {
  saleId: string;
  customerName: string;
  /**
   * Customer phone (E.164 or raw, from Customer.phone). Null when the customer
   * has no phone on record — the widget shows the WhatsApp send button ONLY when
   * both customerPhone and comprobante.pdfUrl are present.
   */
  customerPhone: string | null;
  items: PendingOrderItem[]; // reuse existing item shape (productId, name, quantity, unitPrice ARS)
  totalARS: number;          // ARS pesos (not minor units) — render tool converts to minor units for UCP
  comprobante: DeliveryComprobante;
  envio: DeliveryEnvio | null;
}

// ── resolveWizardPrefill — types extracted to keep file under 300 lines ──────
export type {
  WizardPrefillItem,
  WizardPrefill,
  ResolveWizardPrefillInput,
  ResolveWizardPrefillResult,
} from "./payments-backend-wizard.port";

// ── createTrackedPaymentLink ──────────────────────────────────────────────────

/** Input for the tracked payment-link WRITE path. tenantId is opaque (adapters map to businessId).
 *  idempotencyKey must be widget-generated; the port is agnostic to idempotency semantics. */
export interface CreateTrackedPaymentLinkInput {
  tenantId: string;
  customerId: string;
  items: Array<{ productId: string; quantity: number; unitPriceOverride?: number }>;
  /** Shown on the MP preference page and stored as the PI description. */
  description: string;
  /** Checkout Pro link lifetime in days (1–30). Defaults to 3 inside the adapter. */
  expiresInDays?: number;
  /** Widget-generated stable UUID (created when the form opens). NEVER model-supplied. */
  idempotencyKey: string;
}

/** Domain result. Success: domainError absent, paymentLinkUrl+paymentIntentId+amountARS set.
 *  Error: domainError set (e.g. "mp_not_connected", "payment_links_blocked", "customer_not_found").
 *  amountARS is always DB-derived (NABAOS — never model-supplied). */
export type CreateTrackedPaymentLinkResult =
  | {
      domainError?: undefined;
      paymentLinkUrl: string | null;
      paymentIntentId: string;
      amountARS: number;
    }
  | {
      domainError: string;
      errorMessage?: string;
    };

// ── Port interface ────────────────────────────────────────────────────────────

/**
 * Backend-agnostic payments port for the MCP payments tool pack.
 *
 * Every method maps to one MCP tool (mp_create_preference, mp_payment_status, get_payment_intent_status).
 * Methods do NOT throw for domain-level failures (token missing, intent not found, etc.) —
 * they return a typed output with an error discriminant so payments-tools.ts can build
 * structured isError MCP responses. Infrastructure failures (DB down, unexpected exceptions)
 * may still throw and are caught by the tool handler.
 *
 * Tenant isolation is enforced by each adapter via the opaque tenantId field.
 *
 * HARD CONSTRAINTS (money path — do NOT relax):
 *   - getMpTokenForBusiness, MpConnection credential resolution, and all idempotency
 *     live INSIDE the Velora adapter — this port must stay ignorant of them.
 *   - PaymentProviderAdapter.getStatus is called INSIDE the Velora adapter; the port
 *     only declares the final status shape.
 *   - Do NOT add retry or idempotency at this level.
 */
export interface PaymentsBackend {
  createPreference(input: CreatePreferenceInput): Promise<CreatePreferenceOutput>;
  getMpPaymentStatus(input: GetMpPaymentStatusInput): Promise<GetMpPaymentStatusOutput>;
  getPaymentStatus(input: GetPaymentStatusInput): Promise<GetPaymentStatusOutput>;
  /**
   * Returns at most 20 pending PaymentIntents for the tenant, ordered newest first.
   * READ-ONLY — no mutations.
   */
  listPendingOrders(input: ListPendingOrdersInput): Promise<PendingOrder[]>;
  /**
   * Returns the detail of a single cobro (PaymentIntent), or null when not found.
   * Resolves by paymentIntentId or most-recent PI for customerName (same fuzzy
   * resolution as getPaymentStatus). READ-ONLY — no mutations.
   * Tenant isolation: always scopes by tenantId → businessId.
   */
  getCobroDetail(input: GetCobroDetailInput): Promise<CobroDetail | null>;
  /**
   * Returns the delivery receipt for a confirmed cobro: comprobante + envío data.
   * Resolves by paymentIntentId, saleId, or customerName (at least one required).
   * READ-ONLY — no mutations. Tenant isolation: always scopes by tenantId → businessId.
   * Returns null when the sale/cobro is not found.
   */
  getDeliveryReceipt(input: GetDeliveryReceiptInput): Promise<DeliveryReceipt | null>;
  /**
   * WRITE — money-moving operation.
   * Atomically creates Sale + Invoice + PaymentIntent and generates a MercadoPago
   * Checkout Pro link. Idempotent: same idempotencyKey → same result (no double charge).
   * NABAOS: amountARS in the result is derived from DB prices × quantities, never from
   * a model-supplied total.
   * Tenant isolation: always scopes by tenantId → businessId.
   */
  createTrackedPaymentLink(input: CreateTrackedPaymentLinkInput): Promise<CreateTrackedPaymentLinkResult>;
  /**
   * READ-ONLY — side-effect-free.
   * Resolves product names + prices (from the catalog) and the customer name for
   * the payment-link wizard prefill. Fails fast if any productId is not in the
   * tenant's catalog or the customerId is not found.
   * Tenant isolation: always scopes by tenantId → businessId.
   */
  resolveWizardPrefill(input: ResolveWizardPrefillInput): Promise<ResolveWizardPrefillResult>;
}
