const assert = require("node:assert/strict");
const test = require("node:test");

const {
  nextOnboardingTask,
  pendingOnboardingTasks,
  buildWelcomeMessage,
  buildTransitionMessage,
  ONBOARDING_TASKS,
} = require("../../src/lib/employee-onboarding.ts");

const SAMPLE_BUSINESS = {
  name: "Ferretería Caballito",
  topProductNames: ["Clavos", "Tornillos", "Pintura blanca", "Cemento"],
  topProductSample: { name: "Clavos", price: 200, currency: "ARS" },
};

// ── nextOnboardingTask ────────────────────────────────────────────────

test("nextOnboardingTask: empty events → first_sale", () => {
  assert.equal(nextOnboardingTask([]), "first_sale");
});

test("nextOnboardingTask: after sale.create → first_stock_query", () => {
  const events = [{ actionType: "sale.create" }];
  // first_stock_query no se infiere del audit log (no genera evento), pero
  // como ya completó first_sale, la próxima task pendiente es first_stock_query.
  assert.equal(nextOnboardingTask(events), "first_stock_query");
});

test("nextOnboardingTask: after sale.create + stock-load.create → first_stock_query (still pending)", () => {
  // first_stock_load completed pero first_stock_query NO se completó vía audit
  // — el ordering del array task list garantiza que la primera pendiente sea
  // first_stock_query.
  const events = [
    { actionType: "sale.create" },
    { actionType: "stock-load.create" },
  ];
  assert.equal(nextOnboardingTask(events), "first_stock_query");
});

test("nextOnboardingTask: ignores unrelated audit events", () => {
  const events = [
    { actionType: "product.create" },
    { actionType: "customer.update" },
  ];
  assert.equal(nextOnboardingTask(events), "first_sale");
});

test("nextOnboardingTask: ONBOARDING_TASKS has 6 items including first_cobro_qr and first_sale_send", () => {
  assert.equal(ONBOARDING_TASKS.length, 6);
  assert.deepEqual(ONBOARDING_TASKS, [
    "first_sale",
    "first_stock_query",
    "first_cobro_qr",
    "first_sale_send",
    "first_stock_load",
    "first_sales_query",
  ]);
});

// ── pendingOnboardingTasks (free-order) ───────────────────────────────

test("pendingOnboardingTasks: empty events → all 6 pending", () => {
  assert.deepEqual(pendingOnboardingTasks([]), [
    "first_sale",
    "first_stock_query",
    "first_cobro_qr",
    "first_sale_send",
    "first_stock_load",
    "first_sales_query",
  ]);
});

test("pendingOnboardingTasks: stock-load.create only → first_stock_load not in pending", () => {
  const pending = pendingOnboardingTasks([{ actionType: "stock-load.create" }]);
  assert.ok(!pending.includes("first_stock_load"));
  assert.ok(pending.includes("first_sale"));
  assert.equal(pending.length, 5);
});

test("nextOnboardingTask: free-order — stock-load.create completed first → next pending is first_sale", () => {
  // El empleado puede arrancar por stock_load. La detección no fuerza orden;
  // nextOnboardingTask devuelve la primera pendiente del array canónico.
  const next = nextOnboardingTask([{ actionType: "stock-load.create" }]);
  assert.equal(next, "first_sale");
});

test("nextOnboardingTask: sales query done (DB-persisted) → first_sales_query not pending", () => {
  // Post-persistence refactor: first_sales_query is detected via
  // employee.onboardingSalesQueryDoneAt (DB column), not regex over messages.
  // userMessages param is ignored (_userMessages); must pass employeeFields.
  const employeeFields = {
    onboardingStockQueryDoneAt: null,
    onboardingSalesQueryDoneAt: new Date(),
    onboardingCobroQrDoneAt: null,
    onboardingSaleSendDoneAt: null,
    onboardingCompletedAt: null,
  };
  const next = nextOnboardingTask([], [], employeeFields);
  // first_sales_query done → first_sale is still the first pending task.
  assert.equal(next, "first_sale");
  const pending = pendingOnboardingTasks([], [], employeeFields);
  assert.ok(!pending.includes("first_sales_query"));
});

// ── buildWelcomeMessage ───────────────────────────────────────────────
// Welcome is intentionally SHORT: greeting + ONE concrete instruction.
// It does NOT list all tasks or products — that was the old behavior.
// The single instruction uses generic (non-subtype) copy; subtypes only
// affect buildTransitionMessage (via taskInstruction → SUBTYPE_TASK_RENDERERS).

test("buildWelcomeMessage: includes employee first name and Velora greeting", () => {
  const msg = buildWelcomeMessage({
    employeeName: "Carlos",
    business: SAMPLE_BUSINESS,
    task: "first_sale",
  });
  assert.match(msg, /¡Hola Carlos!/);
  assert.match(msg, /soy Velora/i);
  // Welcome is short — no product listing, no business name in greeting.
  assert.doesNotMatch(msg, /Ferretería Caballito/);
});

test("buildWelcomeMessage: first_sale task → prompts to report a sale", () => {
  const msg = buildWelcomeMessage({
    employeeName: "Ana",
    business: SAMPLE_BUSINESS,
    task: "first_sale",
  });
  // Generic instruction for first_sale — asks employee to narrate a sale.
  assert.match(msg, /primera venta/i);
  // Does NOT list all products (old behavior removed).
  assert.doesNotMatch(msg, /clavos, tornillos/);
});

test("buildWelcomeMessage: first_stock_query task → prompts to query stock", () => {
  const msg = buildWelcomeMessage({
    employeeName: "Juan",
    business: { name: "Café Único", topProductNames: ["Café molido"] },
    task: "first_stock_query",
  });
  // Generic instruction references the top product.
  assert.match(msg, /café molido/i);
});

test("buildWelcomeMessage: first_stock_load task → prompts to report incoming goods", () => {
  const msg = buildWelcomeMessage({
    employeeName: "Pedro",
    business: { name: "Negocio Nuevo", topProductNames: [] },
    task: "first_stock_load",
  });
  // Generic stock-load instruction — no product needed.
  assert.match(msg, /llegaron/i);
});

test("buildWelcomeMessage: each task produces a unique message", () => {
  const tasks = ["first_sale", "first_stock_query", "first_cobro_qr", "first_sale_send", "first_stock_load", "first_sales_query"];
  const messages = tasks.map((task) =>
    buildWelcomeMessage({ employeeName: "x", business: SAMPLE_BUSINESS, task })
  );
  // Every task maps to a different instruction.
  const unique = new Set(messages);
  assert.equal(unique.size, 6);
});

// ── buildTransitionMessage ────────────────────────────────────────────

test("buildTransitionMessage: first_sale completed → next is first_stock_query", () => {
  const msg = buildTransitionMessage({
    completedTask: "first_sale",
    nextTask: "first_stock_query",
    business: SAMPLE_BUSINESS,
  });
  assert.match(msg, /primera venta/i);
  assert.match(msg, /qué tengo de clavos/i);
});

test("buildTransitionMessage: nextTask null → completion message", () => {
  const msg = buildTransitionMessage({
    completedTask: "first_sales_query",
    nextTask: null,
    business: SAMPLE_BUSINESS,
  });
  assert.match(msg, /ya sabés/i);
  assert.doesNotMatch(msg, /tarea/i);
});

test("buildTransitionMessage: each completed task has unique celebration", () => {
  const tasks = ["first_sale", "first_stock_query", "first_cobro_qr", "first_sale_send", "first_stock_load", "first_sales_query"];
  const celebrations = tasks.map((completedTask) =>
    buildTransitionMessage({
      completedTask,
      nextTask: null,
      business: SAMPLE_BUSINESS,
    })
  );
  // Todas distintas (la "ya sabés operar" es la misma pero el preámbulo varía)
  const unique = new Set(celebrations);
  assert.equal(unique.size, 6);
});

// ── business subtype tailoring (via buildTransitionMessage) ───────────────────
// Subtypes affect TRANSITION instructions (SUBTYPE_TASK_RENDERERS), NOT the
// short welcome. Tests verify the correct renderer fires for each subtype.

test("subtype boutique: first_sale uses 'un' prefix with catalog product", () => {
  const msg = buildTransitionMessage({
    completedTask: "first_stock_query",
    nextTask: "first_sale",
    business: {
      name: "Tienda Sol",
      type: "retail boutique ropa",
      topProductNames: ["Pantalón"],
      topProductSample: { name: "Pantalón", price: 5000, currency: "ARS" },
    },
  });
  assert.match(msg, /vendí un pantalón/i);
  // Boutique uses "un" prefix — NOT "vendí 3".
  assert.doesNotMatch(msg, /vendí 3 pantalón/i);
});

test("subtype hardware: first_stock_load reports incoming goods with quantity", () => {
  const msg = buildTransitionMessage({
    completedTask: "first_sale",
    nextTask: "first_stock_load",
    business: {
      name: "Ferretería Centro",
      type: "hardware",
      topProductNames: ["Tornillos 1/4"],
      topProductSample: { name: "Tornillos 1/4", price: 200, currency: "ARS" },
    },
  });
  assert.match(msg, /entraron 30 tornillos/i);
});

test("subtype mini-market: first_sales_query uses real catalog product for price query", () => {
  const msg = buildTransitionMessage({
    completedTask: "first_sale",
    nextTask: "first_sales_query",
    business: {
      name: "Almacén La Esquina",
      type: "mini-market",
      topProductNames: ["Coca 1.5L"],
      topProductSample: { name: "Coca 1.5L", price: 1500, currency: "ARS" },
    },
  });
  // Price query using the real product, not a hardcoded category.
  assert.match(msg, /a cuánto está el coca 1\.5l/i);
});

test("subtype services: first_sale uses catalog product name", () => {
  const msg = buildTransitionMessage({
    completedTask: "first_stock_query",
    nextTask: "first_sale",
    business: {
      name: "Estética Belle",
      type: "services",
      topProductNames: ["Corte"],
      topProductSample: { name: "Corte", price: 3000, currency: "ARS" },
    },
  });
  // Services renderer uses the service name from catalog.
  assert.match(msg, /vendí corte/i);
});

test("subtype retail (default): first_sale uses 'vendí 3' prefix", () => {
  const msg = buildTransitionMessage({
    completedTask: "first_stock_query",
    nextTask: "first_sale",
    business: {
      name: "Negocio Generico",
      type: "other",
      topProductNames: ["Producto"],
      topProductSample: { name: "Producto", price: 1000, currency: "ARS" },
    },
  });
  // Falls into retail-default branch — uses "vendí 3" (not boutique "un", not service).
  assert.match(msg, /vendí 3 producto/i);
  assert.doesNotMatch(msg, /talle/i);
});
