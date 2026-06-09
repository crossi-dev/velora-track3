import type { Tx } from "./tx";

export interface BusinessDetails {
  name: string;
  currency: string;
  cuit: string | null;
  address: string | null;
}

export interface StockLoadSupplier {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  contactName: string | null;
}

export interface ResolvedProduct {
  id: string;
  name: string;
  price: number;
  sku: string | null;
  currentQuantity: number;
}

export interface InventoryUpdateResult {
  stockMovementId: string;
  stockMovementCreatedAt: Date;
  quantityAfter: number;
  totalCost: number;
  cashMovementId: string | null;
}

export interface PurchaseRequestResult {
  id: string;
  requestNumber: string;
  issuedAt: string;
  currency: string;
  totalAmount: number;
  payload: unknown;
}

export interface ResolveSupplierParams {
  businessId: string;
  /** Optional: empty string or null/undefined means no supplier is provided. */
  supplierId?: string | null;
  /** Optional: empty string or null/undefined means no supplier is provided. */
  supplierName?: string | null;
}

export interface ResolveProductParams {
  businessId: string;
  productId: string;
  itemName: string;
  unitPrice: number | null;
  autoCreateProduct: boolean;
}

export interface ApplyInventoryParams {
  businessId: string;
  product: ResolvedProduct;
  quantity: number;
  unitPrice: number | null;
}

export interface CreatePurchaseRequestParams {
  businessId: string;
  business: BusinessDetails;
  supplier: StockLoadSupplier;
  itemName: string;
  quantity: number;
  unitPrice: number | null;
  issuedAt: Date;
}

export interface StockLoadRepositoryPort {
  findBusinessDetails(tx: Tx, businessId: string): Promise<BusinessDetails | null>;
  resolveSupplier(tx: Tx, params: ResolveSupplierParams): Promise<StockLoadSupplier | null>;
  resolveProduct(tx: Tx, params: ResolveProductParams): Promise<ResolvedProduct>;
  applyInventoryUpdate(tx: Tx, params: ApplyInventoryParams): Promise<InventoryUpdateResult>;
  createPurchaseRequest(tx: Tx, params: CreatePurchaseRequestParams): Promise<PurchaseRequestResult>;
}

export interface StockLoadAuditInput {
  actorUserId: string;
  actorEmployeeId: string | null;
  businessId: string;
  actionMeta: { actionType: string; routeScope: string; resourceType: string };
  stockMovementId: string;
  productId: string;
  productName: string;
  supplierId: string | null;
  supplierName: string | null;
  cashMovementId: string | null;
  purchaseRequestId: string | null;
  quantity: number;
  unitPrice: number | null;
  totalCost: number;
}

export interface StockLoadAuditPort {
  recordAudit(params: StockLoadAuditInput): Promise<void>;
}
