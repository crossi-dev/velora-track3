export type TabKey = "main" | "sales" | "inventory" | "budget" | "invoices" | "clients" | "suppliers" | "team" | "servicios" | "settings" | "conversations";
export type QuickActionMode = "menu" | "sale" | "stock" | "movement" | "product" | null;

// Chips contract (mirrors src/app/api/supervisor/_lib/supervisor-chips.ts).
// Duplicated client-side because dashboard code cannot import from /api/*.
export type ChipKind = "single" | "multi" | "action";
export type ChipAction = "subscribe_push";
export interface ChipOption {
  label: string;
  value: string;
  action?: ChipAction;
}
export interface ChipsBundle {
  kind: ChipKind;
  options: ChipOption[];
}

// Generative-UI widget descriptors — the backend emits a typed widget alongside
// chips (slice 2); the client maps `type` → component via WidgetRenderer's
// registry. Schema + union live in widget-schema.ts (mirrors the chips split).
export type {
  WidgetDescriptor,
  SalesSummaryWidget,
  StockTableWidget,
  RecentSalesWidget,
} from "./widget-schema";

// Agent activity bubble — reflects which A2A sub-agents participated in a turn.
// Emitted by the backend in the `agentActivity` field of the chat response.
export interface AgentActivity {
  agentId: string;
  agentLabel: string;
  action: string;
  latencyMs: number;
  icon: string;
}

export type ChatHistoryEntry = {
  id: string;
  kind: "user" | "reply" | "success" | "error";
  text: string;
  timestamp?: number;
  source?: "assistant" | "manager" | "system";
  chips?: ChipsBundle | null;
  agentActivity?: AgentActivity[] | null;
  // Generative-UI widget rendered below the bubble (slice 1: rendering only —
  // nothing emits this yet; slice 2 adds the backend emit). See widget-schema.ts.
  widget?: import("./widget-schema").WidgetDescriptor | null;
};
export type FeedbackTone = "success" | "warning" | "error" | "info";
export interface FeedbackNotice {
  tone: FeedbackTone;
  message: string;
}

// Business domain types — canonical definition lives in @/domain/business.
export type { Business, BusinessType } from "@/domain/business";
export type BusinessSummary = import("@/domain/business").Business;

// Product domain types — canonical definitions live in @/domain/product.
export type { Product, StockMovement } from "@/domain/product";

// Contact domain types — canonical definitions split into dedicated files.
export type { Customer } from "@/domain/customer";
export type { Supplier } from "@/domain/supplier";
export type { ContactRow } from "@/domain/contact"; // keep for backwards compat

// SaleRecord — backwards-compat alias for Sale from @/domain/sale.
// The two types were structurally identical; callers may use either name.
export type { Sale as SaleRecord } from "@/domain/sale";

// Movement domain types — canonical definitions live in @/domain/movement.
export type { CashMovement, MovementType } from "@/domain/movement";

// Sale domain types — canonical definitions live in @/domain/sale.
export type { Sale, SaleItem, ParsedSale, ParsedSaleItem, SaleStatus } from "@/domain/sale";

export interface InvoicePayload {
  business: {
    name: string;
    cuit: string | null;
    address: string | null;
    currency: string;
    ivaCondition?: string | null;
    puntoVenta?: string | null;
    iibb?: string | null;
    activityStart?: string | null;
  };
  customer: {
    name: string;
    firstName?: string | null;
    lastName?: string | null;
    taxId: string | null;
    email: string | null;
    phone: string | null;
  };
  sale: {
    id: string;
    invoiceNumber: string;
    date: string;
    items: Array<{
      productName: string;
      quantity: number;
      unitPrice: number;
      subtotal: number;
    }>;
    total: number;
  };
}

export type InvoiceStatus = "issued" | "sent" | "paid";

export type DocumentType = "invoice" | "receipt";

export interface InvoiceRecord {
  id: string;
  saleId: string;
  invoiceNumber: string;
  documentType: DocumentType;
  issuedAt: string;
  currency: string;
  totalAmount: number;
  status: InvoiceStatus;
  payload: InvoicePayload | null;
}

export interface SettingsForm {
  name: string;
  type: string;
  address: string;
  phone: string;
  whatsappPhone: string;
  // Cobro QR slice 2 — alias MP/CVU del dueño (modo informal).
  alias: string;
  currency: string;
  defaultCustomer: string;
  allowSaleWithoutCustomer: boolean;
  openReceiptAfterSale: boolean;
  autoCreateProductOnStockLoad: boolean;
  suggestWhatsappAfterSale: boolean;
  lowStockThreshold: number;
  allowNegativeStock: boolean;
  // Per-owner opt-in: WA alert when stock drops below threshold. Default OFF.
  notifyLowStockWa: boolean;
  // Datos fiscales y envíos — columnas ya existentes en DB.
  cuit: string;
  ivaCondition: string;
  puntoVenta: string;
  postalCode: string;
  courierPreference: string;
}

export interface MissingFieldHint {
  type: "price";
  productId: string;
  productName: string;
}

export interface AssistantStockDraftItem {
  itemName: string;
  quantity: string;
  unitPrice: string;
}

export interface AssistantStockDraft {
  items: AssistantStockDraftItem[];
  supplierName: string;
}

export type AssistantStockDraftState = AssistantStockDraft;
export type SettingsFormState = SettingsForm;

// Cobro QR draft shown in the chat secondary panel.
// El backend ya creó el PaymentIntent en estado pending; el chat muestra el
// QR placeholder (modo "qr") o el alias del dueño (modo "alias", slice 2 —
// "modo informal" sin API MP) y el empleado confirma manualmente con el botón.
export type CobroQrDraftStatus =
  | "pending"
  | "confirming"
  | "confirmed"
  | "error"
  | "expired"
  // Slice 5 — devolución cash V1. "refund-prompt" es la UI inline de
  // confirmación; "refunding" mientras el POST está in-flight; "refunded"
  // estado final tras OK del server.
  | "refund-prompt"
  | "refunding"
  | "refunded"
  // Cancel path — "cancelling" mientras el POST a /cancel está in-flight.
  // Tras OK (o error de red) la card se desmonta client-side.
  | "cancelling";
export type CobroQrDraftMetodo = "qr" | "alias";
export interface CobroQrDraftState {
  metodo: CobroQrDraftMetodo;
  paymentIntentId: string;
  monto: number;
  qrPlaceholderUrl: string;
  // Solo presente cuando metodo === "alias". Es el alias MP/CVU del dueño
  // que la card muestra en grande con copy-to-clipboard.
  alias: string | null;
  // Slice 3: timeout 2 min — el countdown del cliente lee este ISO. Null
  // significa "sin timeout" (rows legacy pre-migration).
  expiresAt: string | null;
  status: CobroQrDraftStatus;
  errorMessage: string | null;
  // Slice 5 — ISO del momento en que el server marcó el intent como refunded.
  // Solo se popula cuando status === "refunded"; el resto del lifecycle es null.
  refundedAt?: string | null;
  // Cuando el empleado dijo "cobro 5000 a Carlos" y NLU resolvió el cliente,
  // la card lo muestra como "Cliente: Carlos" para confirmación visual.
  matchedCustomerId?: string | null;
  customerName?: string | null;
  // Sandbox flag: true when MP credentials are absent and the QR shown is a
  // placeholder that does NOT process a real payment. UI renders a visible
  // "Sandbox" badge on the QR card so the user knows it's a demo flow.
  sandbox?: boolean;
  // Post-confirm actions (slice 6) — populated after the intent is confirmed
  // by fetching enriched data from the status endpoint. Only present when the
  // payment was associated with a Sale that has an Invoice.
  invoiceId?: string | null;
  customerHasPhone?: boolean | null;
}

// Assistant action types live in assistant-action.types.ts to keep this
// file under the 400-LOC ceiling. Re-exported so existing callers keep
// working unchanged.
export type {
  AssistantDestructiveAction,
  AssistantConfirmationRequest,
  AssistantAction,
} from "./assistant-action.types";

export interface CustomerSelectContext {
  saleText: string;
  clients: { id: string; name: string }[];
}

export interface ChartPoint {
  label: string;
  value: number;
  timestamp?: number;
}

export interface PurchaseRequestPayload {
  business: {
    name: string;
    cuit: string | null;
    address: string | null;
    currency: string;
  };
  supplier: {
    name: string;
    email?: string | null;
    taxId?: string | null;
    phone: string | null;
    contactName: string | null;
  };
  request: {
    id: string;
    requestNumber: string;
    date: string;
    items: Array<{
      itemName: string;
      quantity: number;
      unitPrice: number;
      subtotal: number;
    }>;
    total: number;
  };
}

export interface PurchaseRequestRecord {
  id: string;
  requestNumber: string;
  issuedAt: string;
  currency: string;
  totalAmount: number;
  payload: PurchaseRequestPayload | null;
}

export type DashboardNotificationKind = "success" | "warning" | "critical" | "info";

export interface DashboardNotification {
  id: string;
  kind: DashboardNotificationKind;
  title: string;
  body?: string;
  href?: string;
  ctaLabel?: string;
  timestamp: number;
}
