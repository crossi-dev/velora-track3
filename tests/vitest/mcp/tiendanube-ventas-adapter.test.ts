// tests/vitest/mcp/tiendanube-ventas-adapter.test.ts
//
// Unit tests for the Tiendanube read-only VentasBackend adapter.
//
// Covers:
//   - queryCatalog: name from name.es, price = first variant price as a number,
//     stock = SUM of variant stocks, id = String(product.id)
//   - queryCatalog: optional name search filter (case-insensitive substring)
//   - queryCatalog: pagination stops on last page (< per_page results → one fetch)
//   - queryCatalog: pagination loops until last page (multi-page stores)
//   - queryCatalog: throws TIENDANUBE_NOT_CONNECTED when no credential row
//   - getLowStockProducts: throws "not implemented (read-only adapter)"
//   - getProductStock: throws "not implemented (read-only adapter)"
//
// HTTP calls are mocked via vi.stubGlobal("fetch"). No real API calls are made.
// Prisma is mocked to control credential lookup.
//
// API shape source: tiendanube.github.io/api-documentation/resources/product

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TiendanubeVentasAdapter } from "@/lib/mcp/_lib/tiendanube-ventas.adapter";

// ── Prisma mock ──────────────────────────────────────────────────────────────

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
// We mock decryptCredential so tests don't require AUTH_SECRET in env.
// The mock returns deterministic plaintext JSON for any input.

vi.mock("@/lib/credential-cipher", () => ({
  decryptCredential: vi.fn((ciphertext: string) => {
    // Return the ciphertext as-is in tests — we store pre-encoded JSON as "ciphertext".
    return ciphertext;
  }),
}));

// ── Sample Tiendanube API fixtures ────────────────────────────────────────────

/** Single-variant product with es name. */
function makeSingleVariantProduct(overrides: {
  id?: number;
  name_es?: string;
  price?: string;
  stock?: number;
  sku?: string;
} = {}) {
  return {
    id: overrides.id ?? 1001,
    name: { es: overrides.name_es ?? "Yerba Mate 1kg" },
    variants: [
      {
        id: 9001,
        price: overrides.price ?? "1500.00",
        stock: overrides.stock ?? 42,
        sku: overrides.sku ?? "YERBA-01",
        promotional_price: null,
      },
    ],
  };
}

/**
 * Multi-variant product (e.g. talle S + talle L) with 2 variants.
 * Tests that stock is SUMMED and price comes from the FIRST variant.
 */
function makeMultiVariantProduct() {
  return {
    id: 2002,
    name: { es: "Remera Básica" },
    variants: [
      { id: 8001, price: "2500.00", stock: 10, sku: "REMERA-S", promotional_price: null },
      { id: 8002, price: "2700.00", stock: 5,  sku: "REMERA-L", promotional_price: null },
    ],
  };
}

/** Product with only an English name (no es key). Tests name fallback chain. */
function makeEnglishNameProduct() {
  return {
    id: 3003,
    name: { en: "Basic T-Shirt" },
    variants: [
      { id: 7001, price: "2500.00", stock: 8, sku: "TSHIRT-EN", promotional_price: null },
    ],
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Builds a stored credential JSON string (plain — decryptCredential is mocked). */
function makeStoredCreds(accessToken: string, storeId: string) {
  return JSON.stringify({ accessToken, storeId });
}

/** Builds a mock fetch response returning a JSON array. */
function mockFetchResponse(products: unknown[]) {
  return Promise.resolve(
    new Response(JSON.stringify(products), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

// ── Setup ─────────────────────────────────────────────────────────────────────

let adapter: TiendanubeVentasAdapter;

beforeEach(() => {
  vi.clearAllMocks();
  adapter = new TiendanubeVentasAdapter();

  // Default: credential row exists for tenant "biz-tn-001".
  businessChannelCredentialFindUniqueMock.mockResolvedValue({
    encryptedCredentials: makeStoredCreds("token-abc", "99999"),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── queryCatalog — mapping ────────────────────────────────────────────────────

describe("TiendanubeVentasAdapter — queryCatalog mapping", () => {
  it("maps name from name.es, price as number, stock as sum, id as String(id)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockReturnValueOnce(mockFetchResponse([makeMultiVariantProduct()])),
    );

    const results = await adapter.queryCatalog({ tenantId: "biz-tn-001" });

    expect(results).toHaveLength(1);
    const product = results[0]!;

    // id = String(product.id)
    expect(product.id).toBe("2002");

    // name = name.es
    expect(product.name).toBe("Remera Básica");

    // price = parseFloat(variants[0].price)  — FIRST variant only
    expect(product.price).toBe(2500);

    // stock = sum of both variants (10 + 5 = 15)
    expect(product.stock).toBe(15);

    // sku = first variant's SKU
    expect(product.sku).toBe("REMERA-S");

    // costPrice and weightGrams are not available in TN API
    expect(product.costPrice).toBeNull();
    expect(product.weightGrams).toBeNull();
  });

  it("falls back name.en when name.es is absent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockReturnValueOnce(mockFetchResponse([makeEnglishNameProduct()])),
    );

    const results = await adapter.queryCatalog({ tenantId: "biz-tn-001" });

    expect(results[0]!.name).toBe("Basic T-Shirt");
  });

  it("uses '(sin nombre)' when no language key is present", async () => {
    const noNameProduct = {
      id: 4004,
      name: {},
      variants: [{ id: 6001, price: "500.00", stock: 3, sku: "X", promotional_price: null }],
    };

    vi.stubGlobal(
      "fetch",
      vi.fn().mockReturnValueOnce(mockFetchResponse([noNameProduct])),
    );

    const results = await adapter.queryCatalog({ tenantId: "biz-tn-001" });

    expect(results[0]!.name).toBe("(sin nombre)");
  });

  it("skips products with no variants", async () => {
    const noVariantsProduct = { id: 5005, name: { es: "Fantasma" }, variants: [] };

    vi.stubGlobal(
      "fetch",
      vi.fn().mockReturnValueOnce(
        mockFetchResponse([noVariantsProduct, makeSingleVariantProduct()]),
      ),
    );

    const results = await adapter.queryCatalog({ tenantId: "biz-tn-001" });

    // Only the product with variants should be mapped
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe("1001");
  });
});

// ── queryCatalog — search filter ──────────────────────────────────────────────

describe("TiendanubeVentasAdapter — queryCatalog search", () => {
  it("applies case-insensitive substring filter when search is provided", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockReturnValueOnce(
        mockFetchResponse([
          makeSingleVariantProduct({ id: 1, name_es: "Yerba Mate 1kg" }),
          makeSingleVariantProduct({ id: 2, name_es: "Azúcar 1kg" }),
          makeSingleVariantProduct({ id: 3, name_es: "Mate Cocido" }),
        ]),
      ),
    );

    const results = await adapter.queryCatalog({ tenantId: "biz-tn-001", search: "mate" });

    // "mate" matches "Yerba Mate 1kg" and "Mate Cocido" (case-insensitive)
    expect(results).toHaveLength(2);
    expect(results.map((p) => p.id)).toEqual(expect.arrayContaining(["1", "3"]));
  });

  it("returns all products when search is not provided", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockReturnValueOnce(
        mockFetchResponse([
          makeSingleVariantProduct({ id: 1 }),
          makeSingleVariantProduct({ id: 2 }),
        ]),
      ),
    );

    const results = await adapter.queryCatalog({ tenantId: "biz-tn-001" });

    expect(results).toHaveLength(2);
  });
});

// ── queryCatalog — pagination ─────────────────────────────────────────────────

describe("TiendanubeVentasAdapter — pagination", () => {
  it("stops after ONE fetch when the first page returns fewer than per_page results", async () => {
    const fetchMock = vi.fn().mockReturnValueOnce(
      // 3 products — far below per_page (200). This is the last page.
      mockFetchResponse([
        makeSingleVariantProduct({ id: 1 }),
        makeSingleVariantProduct({ id: 2 }),
        makeSingleVariantProduct({ id: 3 }),
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const results = await adapter.queryCatalog({ tenantId: "biz-tn-001" });

    expect(results).toHaveLength(3);
    // Should have called fetch exactly once
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fetches multiple pages until last page is smaller than per_page", async () => {
    // Simulate a store with 201 products: page 1 = 200 items (full), page 2 = 1 item (last page).
    const page1 = Array.from({ length: 200 }, (_, i) =>
      makeSingleVariantProduct({ id: i + 1 }),
    );
    const page2 = [makeSingleVariantProduct({ id: 201 })];

    const fetchMock = vi
      .fn()
      .mockReturnValueOnce(mockFetchResponse(page1))
      .mockReturnValueOnce(mockFetchResponse(page2));

    vi.stubGlobal("fetch", fetchMock);

    const results = await adapter.queryCatalog({ tenantId: "biz-tn-001" });

    expect(results).toHaveLength(201);
    // Two fetches — page 1 full, page 2 partial (stop)
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Verify page query params
    const [call1, call2] = fetchMock.mock.calls as [[string, unknown], [string, unknown]];
    expect(call1[0]).toContain("page=1");
    expect(call2[0]).toContain("page=2");
  });
});

// ── queryCatalog — error cases ────────────────────────────────────────────────

describe("TiendanubeVentasAdapter — error handling", () => {
  it("throws TIENDANUBE_NOT_CONNECTED when no credential row exists for the tenant", async () => {
    businessChannelCredentialFindUniqueMock.mockResolvedValue(null);

    await expect(
      adapter.queryCatalog({ tenantId: "biz-tn-no-creds" }),
    ).rejects.toThrow("TIENDANUBE_NOT_CONNECTED");
  });

  it("throws when the Tiendanube API returns a non-2xx status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockReturnValueOnce(
        Promise.resolve(new Response("Unauthorized", { status: 401 })),
      ),
    );

    await expect(
      adapter.queryCatalog({ tenantId: "biz-tn-001" }),
    ).rejects.toThrow("401");
  });
});

// ── Read-only guard — write methods throw ─────────────────────────────────────

describe("TiendanubeVentasAdapter — read-only guard", () => {
  it("getLowStockProducts throws 'not implemented (read-only adapter)'", async () => {
    await expect(
      adapter.getLowStockProducts({ tenantId: "biz-tn-001" }),
    ).rejects.toThrow(/not implemented \(read-only adapter\)/i);
  });

  it("getProductStock throws 'not implemented (read-only adapter)'", async () => {
    await expect(
      adapter.getProductStock({ tenantId: "biz-tn-001", productId: "prod-x" }),
    ).rejects.toThrow(/not implemented \(read-only adapter\)/i);
  });
});
