import type { Decimal } from "@prisma/client/runtime/library";

export type AssistantIntent =
  | "answer"
  | "register_sale"
  | "register_movement"
  | "adjust_stock"
  | "edit_product"
  | "delete_product"
  | "create_supplier"
  | "edit_supplier"
  | "delete_supplier"
  | "create_customer"
  | "edit_customer"
  | "delete_customer"
  | "stock_load"
  | "business_query"
  | "bulk_price_update"
  | "report_event"
  | "create_purchase_request"
  | "create_product"
  | "create_budget"
  | "return_sale"
  | "cobro_qr";

export interface AssistantTaskModelResponse {
  intent?: AssistantIntent;
  answer?: string;
  product?:
    | {
        name?: string | null;
      }
    | null;
  productEdit?:
    | {
        field?: string | null;
        value?: string | null;
      }
    | null;
  productEdits?: Array<{
    productName: string;
    field: "price" | "costPrice";
    value: number;
  }> | null;
  productDeletes?: Array<{
    productName: string;
  }> | null;
  stockAdjustment?:
    | {
        mode?: string | null;
        quantity?: number | string | null;
      }
    | null;
  supplier?:
    | {
        name?: string | null;
        phone?: string | null;
        email?: string | null;
        taxId?: string | null;
        contactName?: string | null;
      }
    | null;
  supplierEdit?:
    | {
        field?: string | null;
        value?: string | null;
      }
    | null;
  customer?:
    | {
        name?: string | null;
        phone?: string | null;
        email?: string | null;
        taxId?: string | null;
      }
    | null;
  customerEdit?:
    | {
        field?: string | null;
        value?: string | null;
      }
    | null;
  stockDraft?:
    | {
        itemName?: string | null;
        quantity?: number | string | null;
        unitPrice?: number | string | null;
        supplierName?: string | null;
      }
    | null;
  stockDrafts?:
    | Array<{
        itemName?: string | null;
        quantity?: number | string | null;
        unitPrice?: number | string | null;
      }>
    | null;
  movementDraft?:
    | {
        movementType?: string | null;
        amount?: number | string | null;
        description?: string | null;
      }
    | null;
  bulkPriceUpdate?:
    | {
        amount?: number | null;
        mode?: "percentage" | "absolute" | null;
        direction?: "up" | "down" | "set" | null;
        target?: string | null;
      }
    | null;
  invoiceStatus?: string | null;
  matchedProductId?: string | null;
  matchedInvoiceId?: string | null;
  matchedSupplierId?: string | null;
  matchedCustomerId?: string | null;
  autoSend?: boolean | null;
  // Full sale extraction in single model call (merged parse-sale).
  // When intent === "register_sale", the model returns the sale items and
  // customer name here so the server can resolve the draft without a
  // second /api/parse-sale roundtrip.
  saleDraft?:
    | {
        customerName?: string | null;
        taxId?: string | null;
        items?: Array<{
          productName?: string | null;
          quantity?: number | string | null;
          unitPrice?: number | string | null;
        }> | null;
      }
    | null;
  purchaseRequestDraft?:
    | {
        supplierName?: string | null;
        items?: Array<{
          itemName?: string | null;
          quantity?: number | string | null;
          unitPrice?: number | string | null;
        }> | null;
      }
    | null;
  productDraft?:
    | {
        name?: string | null;
        price?: number | string | null;
        stock?: number | string | null;
        sku?: string | null;
      }
    | null;
  budgetDraft?:
    | {
        customerName?: string | null;
        items?: Array<{
          name?: string | null;
          quantity?: number | string | null;
          unitPrice?: number | string | null;
        }> | null;
        autoSendWhatsapp?: boolean | null;
      }
    | null;
  // Bible §4 — tier 3: el employee marca needed=true cuando no está
  // confiado de qué acción ejecutar. El handler (downstream) muestra
  // `question` al usuario en lugar de ejecutar. `bestGuess` es opcional
  // y ayuda a hacer la pregunta más concreta ("¿quisiste decir X?").
  clarification?:
    | {
        needed?: boolean | null;
        question?: string | null;
        bestGuess?: string | null;
      }
    | null;
  // Self-reported confidence 0..1 from the employee about its own intent
  // selection. Combined post-hoc with assessActionConfidence — if the LLM
  // is below threshold, force clarification even when heuristics pass.
  confidence?: number | null;
  // Reportes de eventos secunjuans embebidos en un mensaje compuesto
  // (rotura, incidente, queja del cliente, aviso de stock). Cuando el
  // mensaje del empleado mezcla una venta principal con un evento
  // secunjuan tipo "ah y se rompió un vaso", el companion lo persiste
  // acá. NO afecta el estado del negocio (no descuenta stock, no crea
  // venta), solo deja constancia visible en el chat compartido para
  // que el dueño/supervisor lo vean. Avisar ≠ modificar (Brief 2026-04-29).
  eventReport?:
    | {
        eventType?: "rotura" | "incidente" | "stock_aviso" | "queja_cliente" | null;
        details?: string | null;
        productName?: string | null;
      }
    | null;
}

export interface SupplierDirectoryEntry {
  name: string;
  phone: string | null;
  email: string | null;
  contactName: string | null;
}

export interface InvoiceDirectoryEntry {
  id: string;
  invoiceNumber: string;
  status: "issued" | "sent" | "paid";
  issuedAt: string;
  customerId: string | null;
  customerName: string;
  customerPhone: string | null;
}

export interface ProductInfoEntry {
  id: string;
  name: string;
  sku: string | null;
  price: number;
  stock: number;
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

export interface PurchaseRequestDirectoryEntry {
  id: string;
  supplierId: string | null;
  requestNumber: string;
  issuedAt: string;
  currency: string;
  totalAmount: number;
  supplierName: string;
  payload: PurchaseRequestPayload | null;
}

export interface LatestPurchaseRequestReference {
  id: string;
  requestNumber: string;
}

export interface AssistantBusinessPromptContext {
  business: {
    name: string;
    type: string | null;
    currency: string;
  };
  cashBalance?: number;
  inventorySummary: {
    productLines: number;
    totalUnits: number;
    totalValue: number;
  };
  products?: Array<{
    name: string;
    price: number;
    stock: number;
  }>;
  suppliers: SupplierDirectoryEntry[];
  recentSales?: Array<{
    date: Date;
    totalAmount: number;
    customer: string | null;
    items: Array<{
      product: string;
      quantity: number;
    }>;
  }>;
  catalog: {
    products: Array<{
      id: string;
      name: string;
      sku: string | null;
    }>;
    customers: Array<{
      id: string;
      name: string;
    }>;
    suppliers: Array<{
      id: string;
      name: string;
    }>;
  };
  salesStats: {
    today: {
      count: number;
      totalAmount: number;
    };
    topProductsByUnitsSold: Array<{
      productName: string;
      unitsSold: number;
    }>;
  };
  activeRules?: Array<{ kind: string; trigger: string; message: string }>;
  currentTime?: string;
}

export interface LoadedBusinessAssistantContext {
  business: {
    name: string;
    type: string | null;
    currency: string;
    products: Array<{
      id: string;
      name: string;
      sku: string | null;
      price: Decimal | number | string;
      quantity: number;
    }>;
    customers: Array<{
      id: string;
      name: string;
    }>;
    suppliers: Array<{
      id: string;
      name: string;
      phone: string | null;
      email: string | null;
      contactName: string | null;
    }>;
    sales: Array<{
      date: Date;
      totalAmount: Decimal | number | string;
      customer: { name: string } | null;
      saleItems: Array<{
        quantity: number;
        product: { name: string } | null;
      }>;
    }>;
  };
  fullCatalogProducts: Array<{
    id: string;
    name: string;
    sku: string | null;
  }>;
  fullCatalogCustomers: Array<{
    id: string;
    name: string;
  }>;
  fullCatalogSuppliers: Array<{
    id: string;
    name: string;
  }>;
  invoiceDirectory: InvoiceDirectoryEntry[];
  purchaseRequestDirectory: PurchaseRequestDirectoryEntry[];
  supplierDirectory: SupplierDirectoryEntry[];
  productInfoDirectory: ProductInfoEntry[];
  context: AssistantBusinessPromptContext;
  contextTerms: string[];
}
