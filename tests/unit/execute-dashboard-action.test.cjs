// @ts-check
"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");

// ── Pre-stub utils.ts en require.cache ──────────────────────────────────────
// utils.ts importa desde @/lib/shared-utils (alias Next.js) que no se puede
// resolver en el runner de Node. Inyectamos un módulo falso ANTES de cargar
// executeDashboardAction.ts para cortocircuitar esa cadena de dependencias.
//
// Las funciones que sí necesitamos de utils.ts son implementadas de forma
// mínima y funcional aquí.

const UTILS_PATH = path.resolve(
  __dirname,
  "../../src/app/dashboard/lib/hooks/utils.ts"
);

// stableSerialize inline (misma lógica que utils.ts)
function stableSerialize(value) {
  if (Array.isArray(value)) {
    return `[${value.map((e) => stableSerialize(e)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableSerialize(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

// Registro en memoria de claves de idempotencia (evita tocar localStorage)
const mutationKeyStore = {};

require.cache[UTILS_PATH] = {
  id: UTILS_PATH,
  filename: UTILS_PATH,
  loaded: true,
  exports: {
    createMutationSignature: (scope, payload) =>
      `${scope}:${stableSerialize(payload)}`,

    getOrCreateMutationKey: (signature) => {
      if (!mutationKeyStore[signature]) {
        mutationKeyStore[signature] = crypto.randomUUID();
      }
      return mutationKeyStore[signature];
    },

    buildMutationHeaders: (signature) => ({
      "Content-Type": "application/json",
      "X-Idempotency-Key":
        mutationKeyStore[signature] ||
        (mutationKeyStore[signature] = crypto.randomUUID()),
    }),

    clearMutationKey: (signature) => {
      delete mutationKeyStore[signature];
    },

    /**
     * fetchWithTimeout: llama a globalThis.fetch con un AbortSignal.
     * La implementación real agrega un setTimeout(abort, 60_000).
     * Aquí la replicamos fielmente para que el test del AbortSignal pase.
     */
    fetchWithTimeout: async (url, options, ms = 60_000) => {
      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(), ms);
      try {
        const res = await globalThis.fetch(url, {
          ...options,
          signal: controller.signal,
        });
        const contentType = res.headers.get("content-type") || "";
        if (contentType.includes("text/html")) {
          throw new Error(
            "Error de conexión al servidor. Revisá tu internet y volvé a intentar."
          );
        }
        return res;
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          throw new Error(
            "Sin respuesta del servidor. Revisá tu conexión y volvé a intentar."
          );
        }
        throw error;
      } finally {
        clearTimeout(id);
      }
    },

    /** getSafeJson: misma lógica que utils.ts */
    getSafeJson: async (res, fallback) => {
      let text = "";
      try {
        text = await res.text();
      } catch {
        throw new Error(fallback);
      }
      if (!text) {
        if (!res.ok) throw new Error(fallback);
        return {};
      }
      let data = {};
      try {
        data = JSON.parse(text);
      } catch {
        if (!res.ok) throw new Error(fallback);
        throw new Error(
          "Error de formato en la respuesta. Por favor, intentá de nuevo."
        );
      }
      if (!res.ok) {
        throw new Error(
          typeof data.error === "string" ? data.error : fallback
        );
      }
      return data;
    },

    // Resto de exports que utils.ts expone (no usados por executeDashboardAction)
    resolveBrowserLocale: () => "es-419",
    normalizePersonOrBusinessName: (v) => v,
    buildCustomerFullName: (f, l) => `${f} ${l}`.trim(),
    splitCustomerName: (v) => ({ firstName: v, lastName: "" }),
    cleanDisplayInput: (v) => v,
    stableSerialize,
    isClearChatCommand: () => false,
    getParsedSaleCommand: () => null,
    looksLikeParsedSaleCorrection: () => false,
    mergeParsedSaleCorrection: (b, c) => `${b}. ${c}`,
    buildEditableSaleText: () => "",
    looksLikeFreshTopLevelTask: () => false,
    shouldContinueAssistantQuestionTurn: () => false,
  },
};

// ── Módulo bajo test ──────────────────────────────────────────────────────────
const {
  executeDashboardAction,
} = require("../../src/app/dashboard/lib/actions/executeDashboardAction.ts");

// ── Helper: construir un Response mock ───────────────────────────────────────
function makeResponse(body, { status = 200, headers = {} } = {}) {
  const bodyStr = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name) => {
        const lower = name.toLowerCase();
        if (lower === "content-type")
          return headers["content-type"] ?? "application/json";
        return headers[lower] ?? null;
      },
    },
    text: async () => bodyStr,
  };
}

// ── Helper: instalar fetch mock y capturar la llamada ────────────────────────
function installFetchMock(responseBody = { ok: true }, responseOptions = {}) {
  let captured = null;

  globalThis.fetch = async (url, options = {}) => {
    const bodyParsed =
      options.body != null ? JSON.parse(options.body) : undefined;
    captured = {
      url,
      method: options.method ?? "GET",
      headers: options.headers ?? {},
      body: bodyParsed,
      signal: options.signal ?? null,
    };
    return makeResponse(responseBody, responseOptions);
  };

  const proxy = { get captured() { return captured; } };
  return { proxy, restore: () => { globalThis.fetch = undefined; } };
}

// ─────────────────────────────────────────────────────────────────────────────
// Bloque 1: URL y método HTTP correcto por action key
// ─────────────────────────────────────────────────────────────────────────────

test("sale.create → POST /api/sales/create", async () => {
  const { proxy, restore } = installFetchMock({
    sale: { id: "s1", totalAmount: 100, status: "confirmed" },
  });
  await executeDashboardAction("sale.create", {
    businessId: "b1",
    items: [{ productId: "p1", quantity: 1, unitPrice: 100 }],
    total: 100,
  });
  assert.equal(proxy.captured.url, "/api/sales/create");
  assert.equal(proxy.captured.method, "POST");
  restore();
});

test("stock.adjust → PATCH /api/products", async () => {
  const { proxy, restore } = installFetchMock({ ok: true });
  await executeDashboardAction("stock.adjust", { id: "p1", stock: 5 });
  assert.equal(proxy.captured.url, "/api/products");
  assert.equal(proxy.captured.method, "PATCH");
  restore();
});

test("stock-load.create → POST /api/stock-loads", async () => {
  const { proxy, restore } = installFetchMock({ stockLoad: { id: "sl1" } });
  await executeDashboardAction("stock-load.create", { quantity: 10 });
  assert.equal(proxy.captured.url, "/api/stock-loads");
  assert.equal(proxy.captured.method, "POST");
  restore();
});

test("cash-movement.create → POST /api/cash-movements", async () => {
  const { proxy, restore } = installFetchMock({ movement: { id: "cm1" } });
  await executeDashboardAction("cash-movement.create", {
    type: "purchase",
    amount: 500,
    description: "Compra de mercadería",
  });
  assert.equal(proxy.captured.url, "/api/cash-movements");
  assert.equal(proxy.captured.method, "POST");
  restore();
});

test("product.create → POST /api/products", async () => {
  const { proxy, restore } = installFetchMock({
    product: { id: "pr1", name: "Mesa" },
  });
  await executeDashboardAction("product.create", {
    businessId: "b1",
    name: "Mesa",
    price: 1000,
    stock: 5,
  });
  assert.equal(proxy.captured.url, "/api/products");
  assert.equal(proxy.captured.method, "POST");
  restore();
});

test("product.update → PATCH /api/products", async () => {
  const { proxy, restore } = installFetchMock({ ok: true });
  await executeDashboardAction("product.update", { id: "pr1", price: 1200 });
  assert.equal(proxy.captured.url, "/api/products");
  assert.equal(proxy.captured.method, "PATCH");
  restore();
});

test("product.delete → DELETE /api/products", async () => {
  const { proxy, restore } = installFetchMock({ ok: true });
  await executeDashboardAction("product.delete", { id: "pr1" });
  assert.equal(proxy.captured.url, "/api/products");
  assert.equal(proxy.captured.method, "DELETE");
  restore();
});

test("product.resolve-or-create → POST /api/products/resolve-or-create", async () => {
  const { proxy, restore } = installFetchMock({
    resolved: false,
    product: { id: "pr-new", name: "Yerba", price: 1500, costPrice: null, sku: "YERBA" },
  });
  await executeDashboardAction("product.resolve-or-create", {
    name: "Yerba",
    price: 1500,
  });
  assert.equal(proxy.captured.url, "/api/products/resolve-or-create");
  assert.equal(proxy.captured.method, "POST");
  assert.deepEqual(proxy.captured.body, { name: "Yerba", price: 1500 });
  restore();
});

test("customer.create → POST /api/customers", async () => {
  const { proxy, restore } = installFetchMock({
    customer: { id: "c1", name: "Ana López" },
  });
  await executeDashboardAction("customer.create", {
    businessId: "b1",
    name: "Ana López",
  });
  assert.equal(proxy.captured.url, "/api/customers");
  assert.equal(proxy.captured.method, "POST");
  restore();
});

test("customer.update → PATCH /api/customers", async () => {
  const { proxy, restore } = installFetchMock({ ok: true });
  await executeDashboardAction("customer.update", {
    id: "c1",
    name: "Ana García",
  });
  assert.equal(proxy.captured.url, "/api/customers");
  assert.equal(proxy.captured.method, "PATCH");
  restore();
});

test("customer.delete → DELETE /api/customers", async () => {
  const { proxy, restore } = installFetchMock({ ok: true });
  await executeDashboardAction("customer.delete", { id: "c1" });
  assert.equal(proxy.captured.url, "/api/customers");
  assert.equal(proxy.captured.method, "DELETE");
  restore();
});

test("supplier.create → POST /api/suppliers", async () => {
  const { proxy, restore } = installFetchMock({
    supplier: { id: "sup1", name: "Distribuidora Norte" },
  });
  await executeDashboardAction("supplier.create", {
    businessId: "b1",
    name: "Distribuidora Norte",
  });
  assert.equal(proxy.captured.url, "/api/suppliers");
  assert.equal(proxy.captured.method, "POST");
  restore();
});

test("supplier.update → PATCH /api/suppliers", async () => {
  const { proxy, restore } = installFetchMock({ ok: true });
  await executeDashboardAction("supplier.update", {
    id: "sup1",
    phone: "+5491123456789",
  });
  assert.equal(proxy.captured.url, "/api/suppliers");
  assert.equal(proxy.captured.method, "PATCH");
  restore();
});

test("supplier.delete → DELETE /api/suppliers", async () => {
  const { proxy, restore } = installFetchMock({ ok: true });
  await executeDashboardAction("supplier.delete", { id: "sup1" });
  assert.equal(proxy.captured.url, "/api/suppliers");
  assert.equal(proxy.captured.method, "DELETE");
  restore();
});

test("invoice.update-status → PATCH /api/invoices/:invoiceId", async () => {
  const { proxy, restore } = installFetchMock({
    invoice: { id: "inv42", status: "paid" },
  });
  await executeDashboardAction("invoice.update-status", {
    invoiceId: "inv42",
    status: "paid",
  });
  assert.equal(proxy.captured.url, "/api/invoices/inv42");
  assert.equal(proxy.captured.method, "PATCH");
  restore();
});

test("invoice.send-whatsapp → POST /api/invoices/:invoiceId/send-whatsapp", async () => {
  const { proxy, restore } = installFetchMock({
    ok: true,
    sentTo: "+5491199998888",
  });
  await executeDashboardAction("invoice.send-whatsapp", {
    invoiceId: "inv99",
    phone: "+5491199998888",
  });
  assert.equal(proxy.captured.url, "/api/invoices/inv99/send-whatsapp");
  assert.equal(proxy.captured.method, "POST");
  restore();
});

test("product.bulk-price-update → POST /api/products/bulk-price-update", async () => {
  const { proxy, restore } = installFetchMock({
    updated: 3,
    summary: "3 productos actualizados",
  });
  await executeDashboardAction("product.bulk-price-update", {
    amount: 10,
    mode: "percentage",
    direction: "up",
  });
  assert.equal(proxy.captured.url, "/api/products/bulk-price-update");
  assert.equal(proxy.captured.method, "POST");
  restore();
});

test("business.update → PATCH /api/business", async () => {
  const { proxy, restore } = installFetchMock({ ok: true });
  await executeDashboardAction("business.update", {
    name: "Mi Negocio Actualizado",
  });
  assert.equal(proxy.captured.url, "/api/business");
  assert.equal(proxy.captured.method, "PATCH");
  restore();
});

test("undo.execute → POST /api/undo", async () => {
  const { proxy, restore } = installFetchMock({
    deleted: 1,
    summary: ["Venta eliminada"],
  });
  await executeDashboardAction("undo.execute", { target: "sale" });
  assert.equal(proxy.captured.url, "/api/undo");
  assert.equal(proxy.captured.method, "POST");
  restore();
});

test("purchase-request.send-whatsapp → POST /api/purchase-requests/:requestId/send-whatsapp", async () => {
  const { proxy, restore } = installFetchMock({ ok: true });
  await executeDashboardAction("purchase-request.send-whatsapp", {
    requestId: "req77",
  });
  assert.equal(
    proxy.captured.url,
    "/api/purchase-requests/req77/send-whatsapp"
  );
  assert.equal(proxy.captured.method, "POST");
  restore();
});

test("budget.create → POST /api/budgets", async () => {
  const { proxy, restore } = installFetchMock({
    budget: { id: "bud1", budgetNumber: "PRES-0001" },
  });
  await executeDashboardAction("budget.create", {
    items: [{ name: "Silla", quantity: 2, unitPrice: 500 }],
  });
  assert.equal(proxy.captured.url, "/api/budgets");
  assert.equal(proxy.captured.method, "POST");
  restore();
});

test("budget.delete → DELETE /api/budgets", async () => {
  const { proxy, restore } = installFetchMock({ ok: true });
  await executeDashboardAction("budget.delete", { budgetId: "bud1" });
  assert.equal(proxy.captured.url, "/api/budgets");
  assert.equal(proxy.captured.method, "DELETE");
  restore();
});

test("budget.send-whatsapp → POST /api/budgets/:budgetId/send-whatsapp", async () => {
  const { proxy, restore } = installFetchMock({
    ok: true,
    sentTo: "+5491155554444",
  });
  await executeDashboardAction("budget.send-whatsapp", {
    budgetId: "bud55",
    phone: "+5491155554444",
  });
  assert.equal(proxy.captured.url, "/api/budgets/bud55/send-whatsapp");
  assert.equal(proxy.captured.method, "POST");
  restore();
});

// ─────────────────────────────────────────────────────────────────────────────
// Bloque 2: Cabeceras de idempotencia
// ─────────────────────────────────────────────────────────────────────────────

test("toda mutación incluye X-Idempotency-Key en los headers", async () => {
  const { proxy, restore } = installFetchMock({ ok: true });
  await executeDashboardAction("product.delete", { id: "pr-idem" });
  assert.ok(
    typeof proxy.captured.headers["X-Idempotency-Key"] === "string" &&
      proxy.captured.headers["X-Idempotency-Key"].length > 0,
    "X-Idempotency-Key debe ser un string no vacío"
  );
  restore();
});

test("X-Idempotency-Key es un UUID válido", async () => {
  const { proxy, restore } = installFetchMock({ ok: true });
  await executeDashboardAction("customer.delete", { id: "c-uuid" });
  const uuidPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  assert.match(proxy.captured.headers["X-Idempotency-Key"], uuidPattern);
  restore();
});

test("Content-Type es application/json en todas las mutaciones", async () => {
  const { proxy, restore } = installFetchMock({ ok: true });
  await executeDashboardAction("business.update", { name: "Test" });
  assert.equal(proxy.captured.headers["Content-Type"], "application/json");
  restore();
});

// ─────────────────────────────────────────────────────────────────────────────
// Bloque 3: Construcción del body para acciones con body especializado
// ─────────────────────────────────────────────────────────────────────────────

test("invoice.update-status envía solo { status } en el body (no invoiceId)", async () => {
  const { proxy, restore } = installFetchMock({
    invoice: { id: "inv1", status: "sent" },
  });
  await executeDashboardAction("invoice.update-status", {
    invoiceId: "inv1",
    status: "sent",
  });
  assert.deepEqual(proxy.captured.body, { status: "sent" });
  restore();
});

test("invoice.send-whatsapp envía { phone, payload, invoiceNumber } en el body", async () => {
  const { proxy, restore } = installFetchMock({ ok: true });
  await executeDashboardAction("invoice.send-whatsapp", {
    invoiceId: "inv1",
    phone: "+5491144443333",
  });
  assert.deepEqual(proxy.captured.body, {
    phone: "+5491144443333",
    payload: null,
    invoiceNumber: null,
  });
  restore();
});

test("invoice.send-whatsapp con phone null envía null para payload e invoiceNumber", async () => {
  const { proxy, restore } = installFetchMock({ ok: true });
  await executeDashboardAction("invoice.send-whatsapp", {
    invoiceId: "inv2",
    phone: null,
  });
  assert.deepEqual(proxy.captured.body, {
    phone: null,
    payload: null,
    invoiceNumber: null,
  });
  restore();
});

test("invoice.send-whatsapp con payload envía el payload completo", async () => {
  const { proxy, restore } = installFetchMock({ ok: true });
  const fakePayload = {
    business: { name: "Test Co", cuit: null, address: null, currency: "ARS" },
    customer: { name: "Cliente", taxId: null, email: null, phone: null },
    sale: { id: "s1", invoiceNumber: "FC-001", date: "2026-01-01", items: [], total: 100 },
  };
  await executeDashboardAction("invoice.send-whatsapp", {
    invoiceId: "inv3",
    phone: "+5491111111111",
    payload: fakePayload,
    invoiceNumber: "FC-001",
  });
  assert.deepEqual(proxy.captured.body, {
    phone: "+5491111111111",
    payload: fakePayload,
    invoiceNumber: "FC-001",
  });
  restore();
});

test("purchase-request.send-whatsapp no envía body (body es null)", async () => {
  const { proxy, restore } = installFetchMock({ ok: true });
  await executeDashboardAction("purchase-request.send-whatsapp", {
    requestId: "req1",
  });
  // body=null → fetchWithTimeout omite la prop body → nuestro mock lo ve como undefined
  assert.equal(proxy.captured.body, undefined);
  restore();
});

test("budget.send-whatsapp envía solo { phone } en el body", async () => {
  const { proxy, restore } = installFetchMock({ ok: true });
  await executeDashboardAction("budget.send-whatsapp", {
    budgetId: "bud1",
    phone: "+5491188887777",
  });
  assert.deepEqual(proxy.captured.body, { phone: "+5491188887777" });
  restore();
});

// ─────────────────────────────────────────────────────────────────────────────
// Bloque 4: Manejo de errores de respuesta
// ─────────────────────────────────────────────────────────────────────────────

test("respuesta 400 con { error: '...' } lanza el mensaje del servidor", async () => {
  const { restore } = installFetchMock(
    { error: "Stock insuficiente" },
    { status: 400 }
  );
  await assert.rejects(
    () =>
      executeDashboardAction("sale.create", {
        businessId: "b1",
        items: [{ productId: "p1", quantity: 99, unitPrice: 10 }],
        total: 990,
      }),
    (err) => {
      assert.ok(err instanceof Error);
      assert.equal(err.message, "Stock insuficiente");
      return true;
    }
  );
  restore();
});

test("respuesta 500 sin campo error usa el fallback en español para product.create", async () => {
  const { restore } = installFetchMock(
    { unexpected: "crash" },
    { status: 500 }
  );
  await assert.rejects(
    () =>
      executeDashboardAction("product.create", {
        businessId: "b1",
        name: "Mesa",
        price: 100,
        stock: 1,
      }),
    (err) => {
      assert.ok(err instanceof Error);
      assert.equal(err.message, "No se pudo crear el producto.");
      return true;
    }
  );
  restore();
});

test("respuesta 404 para stock.adjust usa fallback correcto", async () => {
  const { restore } = installFetchMock({ unexpected: true }, { status: 404 });
  await assert.rejects(
    () => executeDashboardAction("stock.adjust", { id: "p-missing", stock: 0 }),
    (err) => {
      assert.ok(err instanceof Error);
      assert.equal(err.message, "No se pudo ajustar el stock.");
      return true;
    }
  );
  restore();
});

test("respuesta 400 con error string específico para customer.delete", async () => {
  const { restore } = installFetchMock(
    { error: "Cliente tiene facturas asociadas" },
    { status: 400 }
  );
  await assert.rejects(
    () => executeDashboardAction("customer.delete", { id: "c-tied" }),
    (err) => {
      assert.ok(err instanceof Error);
      assert.equal(err.message, "Cliente tiene facturas asociadas");
      return true;
    }
  );
  restore();
});

test("respuesta 422 para invoice.send-whatsapp usa fallback con mención de WhatsApp", async () => {
  const { restore } = installFetchMock({}, { status: 422 });
  await assert.rejects(
    () =>
      executeDashboardAction("invoice.send-whatsapp", {
        invoiceId: "inv1",
        phone: "invalid",
      }),
    (err) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /WhatsApp/);
      return true;
    }
  );
  restore();
});

test("respuesta 500 para budget.delete usa fallback correcto", async () => {
  const { restore } = installFetchMock({}, { status: 500 });
  await assert.rejects(
    () => executeDashboardAction("budget.delete", { budgetId: "bud-fail" }),
    (err) => {
      assert.ok(err instanceof Error);
      assert.equal(err.message, "No se pudo eliminar el presupuesto.");
      return true;
    }
  );
  restore();
});

// ─────────────────────────────────────────────────────────────────────────────
// Bloque 5: Timeout — AbortSignal pasa a fetch
// ─────────────────────────────────────────────────────────────────────────────

test("fetch recibe un AbortSignal para manejar el timeout", async () => {
  let receivedSignal = null;
  globalThis.fetch = async (url, options = {}) => {
    receivedSignal = options.signal ?? null;
    return makeResponse({ deleted: 1, summary: [] });
  };

  await executeDashboardAction("undo.execute", { target: "sale" });

  assert.ok(
    receivedSignal !== null,
    "Se esperaba un AbortSignal en las opciones de fetch"
  );
  assert.ok(
    typeof receivedSignal.aborted === "boolean",
    "El signal debe tener la propiedad aborted"
  );

  globalThis.fetch = undefined;
});

// ─────────────────────────────────────────────────────────────────────────────
// Bloque 6: URLs dinámicas con IDs embebidos
// ─────────────────────────────────────────────────────────────────────────────

test("invoice.update-status embebe el invoiceId correcto en la URL", async () => {
  const { proxy, restore } = installFetchMock({
    invoice: { id: "abc-123", status: "issued" },
  });
  await executeDashboardAction("invoice.update-status", {
    invoiceId: "abc-123",
    status: "issued",
  });
  assert.ok(
    proxy.captured.url.includes("abc-123"),
    "La URL debe incluir el invoiceId"
  );
  restore();
});

test("purchase-request.send-whatsapp embebe el requestId correcto en la URL", async () => {
  const { proxy, restore } = installFetchMock({ ok: true });
  await executeDashboardAction("purchase-request.send-whatsapp", {
    requestId: "req-XYZ-999",
  });
  assert.ok(
    proxy.captured.url.includes("req-XYZ-999"),
    "La URL debe incluir el requestId"
  );
  restore();
});

test("budget.send-whatsapp embebe el budgetId correcto en la URL", async () => {
  const { proxy, restore } = installFetchMock({ ok: true });
  await executeDashboardAction("budget.send-whatsapp", {
    budgetId: "bud-007",
    phone: "+5491100001111",
  });
  assert.ok(
    proxy.captured.url.includes("bud-007"),
    "La URL debe incluir el budgetId"
  );
  restore();
});
