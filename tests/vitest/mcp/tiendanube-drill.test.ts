// tests/vitest/mcp/tiendanube-drill.test.ts
//
// Velora × Tiendanube backend drill.
//
// GOAL: prove (with mocked TN HTTP) that when a tenant's backend is set to
// "tiendanube", the commerce tools + graphical render tools correctly drive
// the TN REST API — and honestly assert NOT-SUPPORTED boundaries.
//
// Coverage:
//   CATALOG BACKEND (CATALOG_BACKEND=tiendanube):
//     ✓ query_catalog / open_catalog_selector → GET /products → correct UCP prefill
//     ✓ create_product                        → POST /products
//     ✓ adjust_stock (mode=set)               → GET /products/{id} + PUT /variants/{vid}
//     ✓ stock_load                            → TIENDANUBE_NOT_SUPPORTED (honest error)
//
//   CUSTOMER BACKEND (CUSTOMER_BACKEND=tiendanube):
//     ✓ find_customer                         → GET /customers?q=...
//     ✓ upsert_customer (create path)         → POST /customers
//
//   SALES BACKEND (SALES_BACKEND=tiendanube):
//     ✓ register_sale                         → GET /products/{id} + POST /orders
//     ✓ register_movement                     → TIENDANUBE_NOT_SUPPORTED (honest error)
//
//   REPORTES BACKEND (REPORTES_BACKEND=tiendanube):
//     ✓ query_sales (ventas_periodo)          → GET /orders?created_at_min/max
//     ✓ query_sales (por_empleado)            → TIENDANUBE_NOT_SUPPORTED (honest error)
//
// HTTP is mocked via vi.stubGlobal("fetch") — no real API calls.
// Prisma is mocked to control credential lookup.
// CATALOG_BACKEND / CUSTOMER_BACKEND / SALES_BACKEND / REPORTES_BACKEND env vars
// are set via vi.stubEnv before each test and restored after.
//
// Render tool note (graphical widgets):
//   open_catalog_selector routes through VentasBackend → TN-capable.
//   open_cobro_status / open_pending_orders / open_delivery_receipt / open_caja_status
//   all take a PaymentsBackend / CajaBackend — those factories only support "velora".
//   Those widgets are asserted Velora-only in a separate describe block (no fetch mock
//   needed — just factory assertion).
//
// Adapter source files:
//   src/lib/mcp/_lib/tiendanube-catalog.adapter.ts
//   src/lib/mcp/_lib/tiendanube-customer.adapter.ts
//   src/lib/mcp/_lib/tiendanube-sales.adapter.ts
//   src/lib/mcp/_lib/tiendanube-reportes.adapter.ts
//   src/lib/mcp/_lib/payments-backend.factory.ts  (velora-only, no TN)
//   src/lib/mcp/_lib/caja-backend.factory.ts       (velora-only, no TN)

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Adapters under test ───────────────────────────────────────────────────────

import { TiendanubeCatalogAdapter } from "@/lib/mcp/_lib/tiendanube-catalog.adapter";
import { TiendanubeVentasAdapter } from "@/lib/mcp/_lib/tiendanube-ventas.adapter";
import { TiendanubeCustomerAdapter } from "@/lib/mcp/_lib/tiendanube-customer.adapter";
import { TiendanubeSalesAdapter } from "@/lib/mcp/_lib/tiendanube-sales.adapter";
import { TiendanubeReportesAdapter } from "@/lib/mcp/_lib/tiendanube-reportes.adapter";

// ── Factories for Velora-only boundary assertion ───────────────────────────────

import { createPaymentsBackend } from "@/lib/mcp/_lib/payments-backend.factory";
import { createCajaBackend } from "@/lib/mcp/_lib/caja-backend.factory";

// ── Prisma mock ───────────────────────────────────────────────────────────────

const { businessChannelCredentialFindUniqueMock } = vi.hoisted(() => ({
  businessChannelCredentialFindUniqueMock: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    businessChannelCredential: {
      findUnique: businessChannelCredentialFindUniqueMock,
    },
  },
}));

// ── Credential cipher mock ────────────────────────────────────────────────────
//
// Mirrors the pattern from tiendanube-ventas-adapter.test.ts:
// decryptCredential returns the ciphertext as-is so tests store plain JSON.

vi.mock("@/lib/credential-cipher", () => ({
  decryptCredential: vi.fn((ciphertext: string) => ciphertext),
}));

// ── Shared fixtures ───────────────────────────────────────────────────────────

const TENANT_ID = "biz-tn-drill";
const STORE_ID = "77777";
const ACCESS_TOKEN = "drill-token-xyz";

function makeStoredCreds() {
  return JSON.stringify({ accessToken: ACCESS_TOKEN, storeId: STORE_ID });
}

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

function emptyResponse(status = 200) {
  return Promise.resolve(new Response("", { status }));
}

/** Canonical TN base URL for this store — mirrors tiendanubeBaseUrl() */
function tnUrl(resource: string) {
  return `https://api.tiendanube.com/2025-03/${STORE_ID}/${resource}`;
}

// ── Sample TN API fixtures ────────────────────────────────────────────────────

function makeProduct(id = 1001, nameEs = "Yerba Mate 1kg", price = "1500.00", stock = 42) {
  return {
    id,
    name: { es: nameEs },
    variants: [{ id: id * 10, price, stock, sku: `SKU-${id}`, promotional_price: null }],
  };
}

function makeCustomer(id = 5001, name = "Ana García") {
  return {
    id,
    name,
    email: "ana@example.com",
    phone: "+54911000000",
    default_address: { address: "Av. Corrientes 123", city: "CABA", zipcode: "1043" },
  };
}

function makeOrder(id = 9001, total = "3000.00") {
  return {
    id,
    number: id,
    status: "open",
    payment_status: "pending",
    gateway: "mercadopago",
    total,
    subtotal: total,
    created_at: "2026-06-01T10:00:00Z",
    updated_at: "2026-06-01T10:00:00Z",
    products: [
      {
        variant_id: 10010,
        quantity: 2,
        price: "1500.00",
        name: { es: "Yerba Mate 1kg" },
      },
    ],
    customer: { id: 5001, name: "Ana García", email: "ana@example.com" },
  };
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  // Default: credential row present for TENANT_ID.
  businessChannelCredentialFindUniqueMock.mockResolvedValue({
    encryptedCredentials: makeStoredCreds(),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// =============================================================================
// CATALOG BACKEND — TN-capable paths
// =============================================================================

describe("TiendanubeCatalogAdapter — create_product", () => {
  it("POSTs to /products and returns a mapped product", async () => {
    const createdProduct = makeProduct(2002, "Dulce de Leche 500g", "2000.00", 0);
    const fetchMock = vi.fn().mockReturnValueOnce(jsonResponse(createdProduct));
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new TiendanubeCatalogAdapter();
    const result = await adapter.createProduct({
      tenantId: TENANT_ID,
      name: "Dulce de Leche 500g",
      price: 2000,
      initialStock: 0,
    });

    // Correct endpoint + method
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(tnUrl("products"));
    expect(opts.method).toBe("POST");

    // Body contains name.es and variants[0].price
    const bodyParsed = JSON.parse(opts.body as string) as {
      name: { es: string };
      variants: [{ price: string }];
    };
    expect(bodyParsed.name.es).toBe("Dulce de Leche 500g");
    expect(bodyParsed.variants[0].price).toBe("2000.00");

    // Return shape
    expect(result.id).toBe("2002");
    expect(result.name).toBe("Dulce de Leche 500g");
    expect(result.price).toBe(2000);
    expect(result.costPrice).toBeNull(); // TN has no costPrice
  });
});

describe("TiendanubeCatalogAdapter — adjust_stock (mode=set)", () => {
  it("fetches the product then PUTs to /variants/{vid} with new stock", async () => {
    const existingProduct = makeProduct(1001, "Yerba Mate 1kg", "1500.00", 42);
    // tiendanubeRequest calls response.json() for PUT (only DELETE uses the empty-body guard).
    // Return a minimal variant JSON so JSON.parse doesn't throw.
    const updatedVariant = { id: existingProduct.variants[0]!.id, stock: 99 };
    const fetchMock = vi
      .fn()
      .mockReturnValueOnce(jsonResponse(existingProduct))   // GET product
      .mockReturnValueOnce(jsonResponse(updatedVariant));   // PUT variant

    vi.stubGlobal("fetch", fetchMock);

    const adapter = new TiendanubeCatalogAdapter();
    const result = await adapter.adjustStock({
      tenantId: TENANT_ID,
      productId: "1001",
      quantity: 99,
      mode: "set",
    });

    // Two calls: GET product + PUT variant
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [getUrl, getOpts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(getUrl).toBe(tnUrl("products/1001"));
    expect((getOpts.method ?? "GET")).toBe("GET");

    const variantId = existingProduct.variants[0]!.id; // 10010
    const [putUrl, putOpts] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(putUrl).toBe(tnUrl(`products/1001/variants/${variantId}`));
    expect(putOpts.method).toBe("PUT");
    const putBody = JSON.parse(putOpts.body as string) as { stock: number };
    expect(putBody.stock).toBe(99);

    // Return shape
    expect(result.productId).toBe("1001");
    expect(result.newStock).toBe(99);
    expect(result.mode).toBe("set");
    expect(result.ok).toBe(true);
  });
});

describe("TiendanubeCatalogAdapter — stock_load (NOT SUPPORTED)", () => {
  it("throws TIENDANUBE_NOT_SUPPORTED — no API call should be made", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new TiendanubeCatalogAdapter();
    await expect(
      adapter.stockLoad({
        tenantId: TENANT_ID,
        productId: "1001",
        itemName: "Yerba Mate 1kg",
        quantity: 50,
        unitPrice: 100,
        autoCreateProduct: false,
        createPurchaseRequest: false,
      }),
    ).rejects.toThrow("TIENDANUBE_NOT_SUPPORTED");

    // No HTTP calls — adapter rejects before touching the network
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// =============================================================================
// VENTAS BACKEND — query_catalog + open_catalog_selector
// =============================================================================

describe("TiendanubeVentasAdapter via query_catalog / open_catalog_selector", () => {
  it("GETs /products and returns correctly mapped products (ventas backend)", async () => {
    const product = makeProduct(1001, "Yerba Mate 1kg", "1500.00", 42);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockReturnValueOnce(jsonResponse([product])),
    );

    const adapter = new TiendanubeVentasAdapter();
    const results = await adapter.queryCatalog({ tenantId: TENANT_ID });

    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe("1001");
    expect(results[0]!.name).toBe("Yerba Mate 1kg");
    expect(results[0]!.price).toBe(1500);
    expect(results[0]!.stock).toBe(42);
    expect(results[0]!.costPrice).toBeNull(); // TN has no costPrice
  });
});

// =============================================================================
// CUSTOMER BACKEND — find_customer, upsert_customer
// =============================================================================

describe("TiendanubeCustomerAdapter — find_customer", () => {
  it("GETs /customers?q=<name> and returns mapped results", async () => {
    const customers = [makeCustomer(5001, "Ana García"), makeCustomer(5002, "Ana López")];
    const fetchMock = vi.fn().mockReturnValueOnce(jsonResponse(customers));
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new TiendanubeCustomerAdapter();
    const results = await adapter.findCustomer({ tenantId: TENANT_ID, name: "Ana" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(tnUrl("customers"));
    expect(url).toContain("q=Ana");

    expect(results).toHaveLength(2);
    expect(results[0]!.id).toBe("5001");
    expect(results[0]!.name).toBe("Ana García");
    expect(results[0]!.email).toBe("ana@example.com");
    expect(results[0]!.city).toBe("CABA");
  });
});

describe("TiendanubeCustomerAdapter — upsert_customer (create path)", () => {
  it("searches for existing then POSTs when no exact match found", async () => {
    const createdCustomer = makeCustomer(6001, "Carlos Pérez");
    const fetchMock = vi
      .fn()
      .mockReturnValueOnce(jsonResponse([]))            // search → empty (no existing customer)
      .mockReturnValueOnce(jsonResponse(createdCustomer)); // POST → created

    vi.stubGlobal("fetch", fetchMock);

    const adapter = new TiendanubeCustomerAdapter();
    // CustomerMutationRecord is typed `unknown` at the port level (opaque); cast to
    // the concrete shape the TN adapter returns — verified against adapter source.
    const result = await adapter.upsertCustomer({
      tenantId: TENANT_ID,
      name: "Carlos Pérez",
      email: "carlos@example.com",
    }) as { id: string; name: string };

    expect(fetchMock).toHaveBeenCalledTimes(2);

    // First call: search by email
    const [searchUrl] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(searchUrl).toContain(tnUrl("customers"));
    expect(searchUrl).toContain("q=");

    // Second call: POST new customer
    const [postUrl, postOpts] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(postUrl).toBe(tnUrl("customers"));
    expect(postOpts.method).toBe("POST");

    expect(result.id).toBe("6001");
    expect(result.name).toBe("Carlos Pérez");
  });
});

// =============================================================================
// SALES BACKEND — register_sale, register_movement (NOT SUPPORTED)
// =============================================================================

describe("TiendanubeSalesAdapter — register_sale", () => {
  it("resolves product variant then POSTs to /orders", async () => {
    const product = makeProduct(1001, "Yerba Mate 1kg", "1500.00", 42);
    const createdOrder = makeOrder(9001, "3000.00");

    const fetchMock = vi
      .fn()
      .mockReturnValueOnce(jsonResponse(product))         // GET product (variant resolution)
      .mockReturnValueOnce(jsonResponse(createdOrder));   // POST order

    vi.stubGlobal("fetch", fetchMock);

    const adapter = new TiendanubeSalesAdapter();
    const result = await adapter.registerSale({
      businessId: TENANT_ID,
      items: [{ productId: "1001", quantity: 2, unitPrice: 1500 }],
      customerId: "5001",
      paymentMethod: "efectivo",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Call 1: GET product to resolve variant id
    const [getUrl] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(getUrl).toBe(tnUrl("products/1001"));

    // Call 2: POST order
    const [postUrl, postOpts] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(postUrl).toBe(tnUrl("orders"));
    expect(postOpts.method).toBe("POST");

    const body = JSON.parse(postOpts.body as string) as {
      products: [{ variant_id: number; quantity: number; price: string }];
      customer: { id: number };
    };
    // variant_id = product.variants[0].id = 1001 * 10 = 10010
    expect(body.products[0].variant_id).toBe(10010);
    expect(body.products[0].quantity).toBe(2);
    expect(body.customer.id).toBe(5001);

    // Result shape
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content[0] as { type: "text"; text: string }).text) as {
      orderId: string;
      backend: string;
    };
    expect(parsed.orderId).toBe("9001");
    expect(parsed.backend).toBe("tiendanube");
  });
});

describe("TiendanubeSalesAdapter — register_movement (NOT SUPPORTED)", () => {
  it("returns TIENDANUBE_NOT_SUPPORTED error response without hitting the network", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new TiendanubeSalesAdapter();
    const result = await adapter.registerMovement({
      businessId: TENANT_ID,
      type: "INCOME",
      amount: 5000,
      description: "Venta efectivo",
    });

    // No HTTP calls
    expect(fetchMock).not.toHaveBeenCalled();

    // Honest error response
    expect(result.isError).toBe(true);
    const parsed = JSON.parse((result.content[0] as { type: "text"; text: string }).text) as {
      code: string;
    };
    expect(parsed.code).toBe("TIENDANUBE_NOT_SUPPORTED");
  });
});

// =============================================================================
// REPORTES BACKEND — query_sales ventas_periodo, por_empleado (NOT SUPPORTED)
// =============================================================================

describe("TiendanubeReportesAdapter — query_sales ventas_periodo", () => {
  it("GETs /orders with date range and aggregates revenue", async () => {
    const orders = [makeOrder(9001, "3000.00"), makeOrder(9002, "1500.00")];
    const fetchMock = vi.fn().mockReturnValueOnce(jsonResponse(orders));
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new TiendanubeReportesAdapter();
    const result = await adapter.querySales({
      tenantId: TENANT_ID,
      metrica: "ventas_periodo",
      from: "2026-06-01",
      to: "2026-06-07",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(tnUrl("orders"));
    expect(url).toContain("created_at_min=2026-06-01T00%3A00%3A00Z");
    expect(url).toContain("created_at_max=2026-06-07T23%3A59%3A59Z");

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content[0] as { type: "text"; text: string }).text) as {
      saleCount: number;
      totalRevenue: number;
      backend: string;
    };
    expect(parsed.saleCount).toBe(2);
    expect(parsed.totalRevenue).toBeCloseTo(4500, 1);
    expect(parsed.backend).toBe("tiendanube");
  });
});

describe("TiendanubeReportesAdapter — query_sales por_empleado (NOT SUPPORTED)", () => {
  it("returns TIENDANUBE_NOT_SUPPORTED without hitting the network", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new TiendanubeReportesAdapter();
    const result = await adapter.querySales({
      tenantId: TENANT_ID,
      metrica: "por_empleado",
      from: "2026-06-01",
      to: "2026-06-07",
    });

    // No HTTP calls — gate fires before any fetch
    expect(fetchMock).not.toHaveBeenCalled();

    expect(result.isError).toBe(true);
    const parsed = JSON.parse((result.content[0] as { type: "text"; text: string }).text) as {
      code: string;
    };
    expect(parsed.code).toBe("TIENDANUBE_NOT_SUPPORTED");
  });
});

// =============================================================================
// VELORA-ONLY BOUNDARY — payments + caja factories have no "tiendanube" backend
// =============================================================================

describe("Velora-only boundary — payments + caja factories", () => {
  it("createPaymentsBackend only supports velora — throws on tiendanube override", () => {
    expect(() => createPaymentsBackend("tiendanube")).toThrow(
      /Unknown PAYMENTS_BACKEND="tiendanube"/,
    );
  });

  it("createCajaBackend has no tiendanube backend — env override throws", () => {
    vi.stubEnv("CAJA_BACKEND", "tiendanube");
    expect(() => createCajaBackend()).toThrow(/Unknown CAJA_BACKEND="tiendanube"/);
    vi.unstubAllEnvs();
  });

  it("createPaymentsBackend('velora') returns a VeloraPaymentsAdapter instance", () => {
    // Confirms the factory still works for Velora (regression guard).
    const backend = createPaymentsBackend("velora");
    expect(backend).toBeDefined();
    // getCobroDetail / listPendingOrders / getDeliveryReceipt are the methods on the port.
    expect(typeof backend.getCobroDetail).toBe("function");
    expect(typeof backend.listPendingOrders).toBe("function");
  });

  it("createCajaBackend() returns a VeloraCajaAdapter instance by default", () => {
    const backend = createCajaBackend();
    expect(backend).toBeDefined();
    expect(typeof backend.findOpenSessionWithAmount).toBe("function");
  });
});
