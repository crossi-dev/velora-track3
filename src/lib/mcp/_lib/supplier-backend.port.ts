// src/lib/mcp/_lib/supplier-backend.port.ts — Backend-agnostic port for supplier MCP tools.
//
// Decouples the 2 supplier write tools from Velora's concrete use-case layer.
// A future FudoSupplierAdapter (or any other backend) implements this interface
// and requires ZERO changes to supplier-tools.ts or the MCP server.
//
// Design mirrors catalog-backend.port.ts / engine-adapter.ts:
//   port (this file) → adapter (velora-supplier.adapter.ts) → factory (supplier-backend.factory.ts)
//
// tenantId is opaque here — the Velora adapter maps it to businessId internally
// so the port name doesn't hard-wire Velora's domain vocabulary.
//
// Input/output types are inlined from the handler signatures in supplier-tools.ts.
// They are intentionally narrow (tool-contract shapes) — not the full domain types.
// The port is a seam, not a full domain model.

export interface ListSuppliersInput {
  tenantId: string;
  search?: string;
}

export interface ListSuppliersResult {
  id: string;
  name: string;
  phone: string | null;
  contactName: string | null;
}

export interface CreateSupplierInput {
  tenantId: string;
  name: string;
  phone?: string | null;
  email?: string | null;
  contactName?: string | null;
  leadTimeDays?: number | null;
}

export interface CreateSupplierOutput {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  contactName: string | null;
  leadTimeDays: number;
}

export interface CreatePurchaseRequestInput {
  tenantId: string;
  supplierId?: string | null;
  supplierName?: string | null;
  itemName: string;
  quantity: number;
  unitPrice: number;
}

export interface CreatePurchaseRequestOutput {
  id: string;
  requestNumber: string;
  ok: true;
}

export interface EditSupplierInput {
  tenantId: string;
  supplierId: string;
  name?: string;
  phone?: string | null;
  email?: string | null;
  contactName?: string | null;
  leadTimeDays?: number | null;
}

export interface EditSupplierOutput {
  supplierId: string;
  ok: true;
}

export interface DeleteSupplierInput {
  tenantId: string;
  supplierId: string;
}

export interface DeleteSupplierOutput {
  supplierId: string;
  ok: true;
}

/**
 * Backend-agnostic supplier port for the MCP supplier tool pack.
 *
 * Every method maps to one MCP tool (create_supplier, create_purchase_request,
 * edit_supplier, delete_supplier).
 * Throw an Error with a domain code (e.g. "SUPPLIER_NOT_FOUND") for error-path handling —
 * supplier-tools.ts converts thrown errors to MCP isError responses.
 *
 * Tenant isolation is enforced by each adapter via the opaque tenantId field.
 */
export interface SupplierBackend {
  listSuppliers(input: ListSuppliersInput): Promise<ListSuppliersResult[]>;
  createSupplier(input: CreateSupplierInput): Promise<CreateSupplierOutput>;
  createPurchaseRequest(input: CreatePurchaseRequestInput): Promise<CreatePurchaseRequestOutput>;
  editSupplier(input: EditSupplierInput): Promise<EditSupplierOutput>;
  deleteSupplier(input: DeleteSupplierInput): Promise<DeleteSupplierOutput>;
}
