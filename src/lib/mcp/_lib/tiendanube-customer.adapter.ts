// src/lib/mcp/_lib/tiendanube-customer.adapter.ts — Tiendanube CustomerBackend adapter.
//
// Implements the CustomerBackend port against the Tiendanube REST API so that
// find_customer, upsert_customer, and delete_customer operate on a real Tiendanube
// store instead of the Velora DB.
//
// HTTP client, credential loading, and shared helpers live in tiendanube-ventas.client.ts.
//
// FIELD MAPPING DECISIONS:
//   - TN Customer.name is a single string (not split first/last). Mapped to CustomerSearchResult.name directly.
//   - TN Customer.default_address provides address, city, zipcode → maps to address, city, postalCode.
//   - upsert_customer: when customerId is provided → PUT /customers/{id}.
//                      when not provided → search by email/phone first; if found → PUT; if not → POST.
//   - delete_customer: TN returns 422 when the customer has existing orders. We catch
//     and surface this as errResponse({ outcome: "has_history" }) — honest, not fake success.
//
// Source: tiendanube.github.io/api-documentation (verified 2026-06-08).

import type {
  CustomerBackend,
  FindCustomerInput,
  CustomerSearchResult,
  ListCustomersInput,
  ListCustomersResult,
  UpsertCustomerInput,
  CustomerMutationRecord,
  DeleteCustomerInput,
  DeleteCustomerOutput,
} from "./customer-backend.port";
import {
  loadTiendanubeCredentials,
  tiendanubeBaseUrl,
  tiendanubeRequest,
  type TiendanubeCustomer,
} from "./tiendanube-ventas.client";

// ── Mapping helpers ───────────────────────────────────────────────────────────

function mapToSearchResult(c: TiendanubeCustomer): CustomerSearchResult {
  return {
    id: String(c.id),
    name: c.name,
    phone: c.phone ?? null,
    email: c.email ?? null,
    address: c.default_address?.address ?? null,
    postalCode: c.default_address?.zipcode ?? null,
    city: c.default_address?.city ?? null,
  };
}

function mapToListResult(c: TiendanubeCustomer): ListCustomersResult {
  return { id: String(c.id), name: c.name, phone: c.phone ?? null };
}

// ── Credential guard ──────────────────────────────────────────────────────────

async function requireCredentials(tenantId: string) {
  const credentials = await loadTiendanubeCredentials(tenantId);
  if (!credentials) {
    throw new Error(
      "TIENDANUBE_NOT_CONNECTED: No Tiendanube credentials found for this business. " +
        "Connect via BusinessChannelCredential with provider='tiendanube'.",
    );
  }
  return credentials;
}

// ── Adapter ────────────────────────────────────────────────────────────────────

/**
 * Tiendanube CustomerBackend adapter.
 *
 * Credential setup (one-time per tenant):
 *   encryptCredential(JSON.stringify({ accessToken: "<token>", storeId: "<numericId>" }))
 *   → insert BusinessChannelCredential { businessId, provider: "tiendanube", encryptedCredentials }
 *   → set TenantToolConfig.customer = "tiendanube"
 */
export class TiendanubeCustomerAdapter implements CustomerBackend {
  // ── find_customer ───────────────────────────────────────────────────────────

  async findCustomer(input: FindCustomerInput): Promise<CustomerSearchResult[]> {
    const { tenantId, name, phone } = input;
    const credentials = await requireCredentials(tenantId);

    const params = new URLSearchParams();
    // TN supports q (name/email search) and phone filters.
    if (name) params.set("q", name);
    if (phone) params.set("phone", phone);
    params.set("per_page", "50");

    const url =
      `${tiendanubeBaseUrl(credentials.storeId, "customers")}?${params.toString()}`;

    const results = await tiendanubeRequest<TiendanubeCustomer[]>(url, credentials.accessToken);
    return results.map(mapToSearchResult);
  }

  // ── listCustomers ───────────────────────────────────────────────────────────

  async listCustomers(input: ListCustomersInput): Promise<ListCustomersResult[]> {
    const { tenantId, search } = input;
    const credentials = await requireCredentials(tenantId);

    const params = new URLSearchParams({ per_page: "50" });
    if (search) params.set("q", search);

    const url =
      `${tiendanubeBaseUrl(credentials.storeId, "customers")}?${params.toString()}`;

    const results = await tiendanubeRequest<TiendanubeCustomer[]>(url, credentials.accessToken);
    return results.map(mapToListResult);
  }

  // ── upsert_customer ─────────────────────────────────────────────────────────

  async upsertCustomer(input: UpsertCustomerInput): Promise<CustomerMutationRecord> {
    const { tenantId, customerId, name, phone, email, address, postalCode, city } = input;
    const credentials = await requireCredentials(tenantId);

    const body: Record<string, unknown> = {};
    if (name !== undefined) body.name = name;
    if (phone !== undefined) body.phone = phone;
    if (email !== undefined) body.email = email;
    if (address !== undefined || postalCode !== undefined || city !== undefined) {
      body.default_address = {
        ...(address !== undefined ? { address } : {}),
        ...(postalCode !== undefined ? { zipcode: postalCode } : {}),
        ...(city !== undefined ? { city } : {}),
      };
    }

    if (customerId) {
      // Known ID → PUT
      const url = tiendanubeBaseUrl(credentials.storeId, `customers/${customerId}`);
      const updated = await tiendanubeRequest<TiendanubeCustomer>(
        url, credentials.accessToken, "PUT", body,
      );
      return mapToSearchResult(updated);
    }

    // No ID: try to find existing by email or phone to avoid duplicates.
    // IMPORTANT: TN's q= is fuzzy full-text — results may include partial matches.
    // We must exact-match after fetching to avoid updating the wrong customer on a
    // substring collision (e.g. q="carlos@" matches "carlos@gmail.com" AND "carlossomething@x.com").
    if (email || phone) {
      const params = new URLSearchParams({ per_page: "10" });
      if (email) params.set("q", email);
      else if (phone) params.set("phone", phone!);

      const searchUrl =
        `${tiendanubeBaseUrl(credentials.storeId, "customers")}?${params.toString()}`;
      const candidates = await tiendanubeRequest<TiendanubeCustomer[]>(
        searchUrl, credentials.accessToken,
      );

      // Exact case-insensitive match on whichever key we searched by.
      const emailLower = email?.toLowerCase();
      const exactMatch = candidates.find((c) => {
        if (emailLower && c.email) return c.email.toLowerCase() === emailLower;
        if (phone && c.phone) return c.phone === phone;
        return false;
      });

      if (exactMatch) {
        const putUrl = tiendanubeBaseUrl(credentials.storeId, `customers/${exactMatch.id}`);
        const updated = await tiendanubeRequest<TiendanubeCustomer>(
          putUrl, credentials.accessToken, "PUT", body,
        );
        return mapToSearchResult(updated);
      }
    }

    // Not found → POST new customer
    const postUrl = tiendanubeBaseUrl(credentials.storeId, "customers");
    const created = await tiendanubeRequest<TiendanubeCustomer>(
      postUrl, credentials.accessToken, "POST", body,
    );
    return mapToSearchResult(created);
  }

  // ── delete_customer ─────────────────────────────────────────────────────────
  //
  // TN returns 422 when the customer has orders — we surface this honestly as
  // { outcome: "has_history" } instead of a fake success or an unhandled throw.

  async deleteCustomer(input: DeleteCustomerInput): Promise<DeleteCustomerOutput> {
    const { tenantId, customerId } = input;
    const credentials = await requireCredentials(tenantId);

    const url = tiendanubeBaseUrl(credentials.storeId, `customers/${customerId}`);
    try {
      await tiendanubeRequest(url, credentials.accessToken, "DELETE");
      return { outcome: "deleted", ok: true };
    } catch (err) {
      const e = err as Error & { status?: number };
      // 422 = customer has orders → honest "has_history" response.
      // tiendanubeRequest throws with status=422 on the error object.
      if (e.status === 422 || e.message?.startsWith("TIENDANUBE_422:")) {
        // TN does not return counts — surface 0 as "unknown" rather than inventing values.
        return { outcome: "has_history", invoiceCount: 0, saleCount: 0 };
      }
      throw err;
    }
  }
}
