import type { ActorRole } from "@/app/api/_lib/resolve-actor";
import type {
  AssistantBusinessPromptContext,
  AssistantIntent,
  AssistantTaskModelResponse,
  InvoiceDirectoryEntry,
  ProductInfoEntry,
  PurchaseRequestDirectoryEntry,
  SupplierDirectoryEntry,
} from "./types";

export interface PreModelIntentParams {
  text: string;
  locale: string;
  recentHistory: Array<{ role: "user" | "assistant"; text: string }>;
  context: AssistantBusinessPromptContext;
  business: { name: string; type: string | null; currency: string };
  productInfoDirectory: ProductInfoEntry[];
  supplierDirectory: SupplierDirectoryEntry[];
  invoiceDirectory: InvoiceDirectoryEntry[];
  purchaseRequestDirectory: PurchaseRequestDirectoryEntry[];
  activeInvoiceId: string | undefined;
  latestPurchaseRequestId: string | undefined;
  latestPurchaseRequestNumber: string | undefined;
  actorRole: ActorRole;
  businessId: string;
  actorUserId: string;
  actorEmployeeId: string | null;
}

export interface PostModelIntentParams {
  text: string;
  locale: string;
  safeIntent: AssistantIntent | "answer";
  parsed: AssistantTaskModelResponse;
  answer: string;
  context: AssistantBusinessPromptContext;
  fullCatalogProducts: Array<{ id: string; name: string; sku: string | null; price?: number | string | null }>;
  fullCatalogCustomers: Array<{ id: string; name: string }>;
  fullCatalogSuppliers: Array<{ id: string; name: string }>;
  productInfoDirectory: ProductInfoEntry[];
  trace: { add: (step: string, detail: string) => void; toJSON: () => Record<string, unknown> | null };
  businessId: string;
  actorRole: ActorRole;
  actorUserId: string;
  actorEmployeeId: string | null;
}
