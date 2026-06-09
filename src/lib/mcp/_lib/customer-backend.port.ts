// src/lib/mcp/_lib/customer-backend.port.ts — Backend-agnostic port for customer MCP tools.
//
// Decouples the 2 customer tools from Velora's concrete query/mutation layer.
// A future FudoCustomerAdapter (or any other backend) implements this interface
// and requires ZERO changes to customer-tools.ts or the MCP server.
//
// Design mirrors catalog-backend.port.ts / engine-adapter.ts:
//   port (this file) → adapter (velora-customer.adapter.ts) → factory (customer-backend.factory.ts)
//
// tenantId is opaque here — the Velora adapter maps it to businessId internally
// so the port name doesn't hard-wire Velora's domain vocabulary.
//
// Input/output types are inlined from the handler signatures in customer-queries.ts.
// They are intentionally narrow (tool-contract shapes) — not the full domain types.
// The port is a seam, not a full domain model.

export interface FindCustomerInput {
  tenantId: string;
  name?: string;
  phone?: string;
}

export interface ListCustomersInput {
  tenantId: string;
  search?: string;
}

export interface ListCustomersResult {
  id: string;
  name: string;
  phone: string | null;
}

export interface CustomerSearchResult {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  postalCode: string | null;
  city: string | null;
}

export interface UpsertCustomerInput {
  tenantId: string;
  /** When provided, updates the existing customer with this id. */
  customerId?: string;
  name?: string;
  phone?: string;
  email?: string;
  address?: string;
  postalCode?: string;
  city?: string;
}

// CustomerMutationRecord is passed through from the shared infra layer — kept opaque at the port level.
export type CustomerMutationRecord = unknown;

export interface DeleteCustomerInput {
  tenantId: string;
  customerId: string;
}

export type DeleteCustomerOutput =
  | { outcome: "deleted"; ok: true }
  | { outcome: "has_history"; invoiceCount: number; saleCount: number };

/**
 * Backend-agnostic customer port for the MCP customer tool pack.
 *
 * Every method maps to one MCP tool (find_customer, upsert_customer, delete_customer).
 * Throw an Error with a domain code (e.g. "CUSTOMER_NOT_FOUND") for error-path handling —
 * customer-tools.ts converts thrown errors to MCP isError responses.
 *
 * Tenant isolation is enforced by each adapter via the opaque tenantId field.
 */
export interface CustomerBackend {
  findCustomer(input: FindCustomerInput): Promise<CustomerSearchResult[]>;
  listCustomers(input: ListCustomersInput): Promise<ListCustomersResult[]>;
  upsertCustomer(input: UpsertCustomerInput): Promise<CustomerMutationRecord>;
  deleteCustomer(input: DeleteCustomerInput): Promise<DeleteCustomerOutput>;
}
