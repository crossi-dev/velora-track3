const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");

const {
  clearMockModules,
  resetSourceModules,
  setMockModule,
} = require("../phase4/module-hooks.cjs");

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

function makeNextServerMock() {
  return {
    NextRequest: class NextRequest {},
    NextResponse: {
      json: jsonResponse,
    },
  };
}

function loadModule(relativePath, mocks = {}) {
  resetSourceModules();
  clearMockModules();
  // Ensures the phase4 module hooks are installed even when this load has no mocks.
  setMockModule("__codex_module_hooks__", {});
  clearMockModules();

  for (const [request, exports] of Object.entries(mocks)) {
    setMockModule(request, exports);
  }

  return require(path.join(process.cwd(), relativePath));
}

function makeRequest(body) {
  return {
    headers: new Headers(),
    async json() {
      return body;
    },
  };
}

function makeBusiness(overrides = {}) {
  return {
    id: "biz-1",
    userId: "user-1",
    ...overrides,
  };
}

function makeCustomer(overrides = {}) {
  return {
    id: "cust-1",
    businessId: "biz-1",
    name: "Juan García",
    phone: null,
    email: null,
    taxId: null,
    ...overrides,
  };
}

function makeSupplier(overrides = {}) {
  return {
    id: "sup-1",
    businessId: "biz-1",
    name: "Proveedor Uno",
    phone: null,
    email: null,
    contactName: null,
    ...overrides,
  };
}

function createFakeContactsPrisma(seed = {}) {
  const business = makeBusiness(seed.business);
  const customers = new Map(
    (seed.customers ?? [makeCustomer()]).map((customer) => [customer.id, { ...customer }])
  );
  const suppliers = new Map(
    (seed.suppliers ?? [makeSupplier()]).map((supplier) => [supplier.id, { ...supplier }])
  );

  const state = {
    business,
    customers,
    suppliers,
    invoices: (seed.invoices ?? []).map((invoice) => ({ ...invoice })),
    sales: (seed.sales ?? []).map((sale) => ({ ...sale })),
    mockPurchaseRequests: (seed.mockPurchaseRequests ?? []).map((request) => ({ ...request })),
  };

  function customerMatches(record, where = {}) {
    if (!record) return false;
    if (where.id && record.id !== where.id) return false;
    if (where.businessId && record.businessId !== where.businessId) return false;
    if (where.name && record.name !== where.name) return false;
    if (where.id?.not && record.id === where.id.not) return false;
    return true;
  }

  function supplierMatches(record, where = {}) {
    if (!record) return false;
    if (where.id && record.id !== where.id) return false;
    if (where.businessId && record.businessId !== where.businessId) return false;
    if (where.name && record.name !== where.name) return false;
    if (where.id?.not && record.id === where.id.not) return false;
    return true;
  }

  const prisma = {
    state,
    business: {
      findUnique: async ({ where }) => {
        if (where?.userId && where.userId === business.userId) {
          return { id: business.id };
        }
        if (where?.id && where.id === business.id) {
          return { id: business.id };
        }
        return null;
      },
    },
    customer: {
      findFirst: async ({ where }) => {
        for (const customer of state.customers.values()) {
          if (customerMatches(customer, where)) return { ...customer };
        }
        return null;
      },
      create: async ({ data, select }) => {
        const id = `cust-${state.customers.size + 1}`;
        const created = {
          id,
          businessId: data.businessId,
          name: data.name,
          phone: data.phone ?? null,
          email: data.email ?? null,
          taxId: data.taxId ?? null,
        };
        state.customers.set(id, created);
        if (!select) return { ...created };
        return Object.fromEntries(Object.keys(select).map((key) => [key, created[key]]));
      },
      updateMany: async ({ where, data }) => {
        let count = 0;
        for (const [id, customer] of state.customers.entries()) {
          if (!customerMatches(customer, where)) continue;
          state.customers.set(id, { ...customer, ...data });
          count += 1;
        }
        return { count };
      },
      deleteMany: async ({ where }) => {
        let count = 0;
        for (const [id, customer] of state.customers.entries()) {
          if (!customerMatches(customer, where)) continue;
          state.customers.delete(id);
          count += 1;
        }
        return { count };
      },
    },
    supplier: {
      findFirst: async ({ where }) => {
        for (const supplier of state.suppliers.values()) {
          if (supplierMatches(supplier, where)) return { ...supplier };
        }
        return null;
      },
      create: async ({ data, select }) => {
        const id = `sup-${state.suppliers.size + 1}`;
        const created = {
          id,
          businessId: data.businessId,
          name: data.name,
          phone: data.phone ?? null,
          email: data.email ?? null,
          contactName: data.contactName ?? null,
        };
        state.suppliers.set(id, created);
        if (!select) return { ...created };
        return Object.fromEntries(Object.keys(select).map((key) => [key, created[key]]));
      },
      updateMany: async ({ where, data }) => {
        let count = 0;
        for (const [id, supplier] of state.suppliers.entries()) {
          if (!supplierMatches(supplier, where)) continue;
          state.suppliers.set(id, { ...supplier, ...data });
          count += 1;
        }
        return { count };
      },
      delete: async ({ where }) => {
        const supplier = state.suppliers.get(where.id);
        if (!supplier) {
          throw new Error("supplier not found");
        }
        state.suppliers.delete(where.id);
        return { ...supplier };
      },
    },
    invoice: {
      findMany: async ({ where, select }) => {
        const rows = state.invoices.filter((invoice) => {
          if (where?.businessId && invoice.businessId !== where.businessId) return false;
          if (where?.customerId && invoice.customerId !== where.customerId) return false;
          if (where?.status?.not && invoice.status === where.status.not) return false;
          return true;
        });
        if (!select) return rows.map((invoice) => ({ ...invoice }));
        return rows.map((invoice) => {
          const next = {};
          for (const key of Object.keys(select)) {
            next[key] = invoice[key];
          }
          return next;
        });
      },
      update: async ({ where, data }) => {
        const index = state.invoices.findIndex((invoice) => invoice.id === where.id);
        if (index >= 0) {
          state.invoices[index] = { ...state.invoices[index], ...data };
        }
        return state.invoices[index] ? { ...state.invoices[index] } : null;
      },
      updateMany: async ({ where, data }) => {
        let count = 0;
        state.invoices = state.invoices.map((invoice) => {
          if (where?.businessId && invoice.businessId !== where.businessId) return invoice;
          if (where?.customerId && invoice.customerId !== where.customerId) return invoice;
          count += 1;
          return { ...invoice, ...data };
        });
        return { count };
      },
    },
    sale: {
      updateMany: async ({ where, data }) => {
        let count = 0;
        state.sales = state.sales.map((sale) => {
          if (where?.businessId && sale.businessId !== where.businessId) return sale;
          if (where?.customerId && sale.customerId !== where.customerId) return sale;
          count += 1;
          return { ...sale, ...data };
        });
        return { count };
      },
    },
    async $queryRawUnsafe(sql, ...params) {
      if (sql.includes("FROM MockPurchaseRequest")) {
        const [businessId, supplierId] = params;
        return state.mockPurchaseRequests
          .filter((request) => request.businessId === businessId && request.supplierId === supplierId)
          .map((request) => ({ id: request.id, payloadJson: request.payloadJson }));
      }
      return [];
    },
    async $executeRawUnsafe(sql, ...params) {
      if (sql.startsWith("CREATE TABLE IF NOT EXISTS MockPurchaseRequest")) {
        return 0;
      }

      if (sql.startsWith("UPDATE MockPurchaseRequest SET payloadJson")) {
        const [payloadJson, id] = params;
        state.mockPurchaseRequests = state.mockPurchaseRequests.map((request) =>
          request.id === id ? { ...request, payloadJson } : request
        );
        return 1;
      }

      if (sql.startsWith("UPDATE MockPurchaseRequest SET supplierId = NULL")) {
        const [businessId, supplierId] = params;
        state.mockPurchaseRequests = state.mockPurchaseRequests.map((request) =>
          request.businessId === businessId && request.supplierId === supplierId
            ? { ...request, supplierId: null }
            : request
        );
        return 1;
      }

      return 0;
    },
    async $transaction(callback) {
      const tx = {
        invoice: prisma.invoice,
        sale: prisma.sale,
        customer: prisma.customer,
        supplier: prisma.supplier,
        $queryRawUnsafe: prisma.$queryRawUnsafe,
        $executeRawUnsafe: prisma.$executeRawUnsafe,
      };
      return callback(tx);
    },
  };

  return { prisma, state };
}

function makeRouteMocks(prisma, authUserId = "user-1") {
  return {
    "next/server": makeNextServerMock(),
    "@/lib/prisma": { prisma },
    "@/auth": {
      auth: async () => ({ user: { id: authUserId } }),
      signIn: async () => {},
      signOut: async () => {},
    },
    "@/app/api/_lib/critical-write-audit": {
      recordCriticalWriteEvent: async () => {},
    },
  };
}

function withBrowserGlobals({ innerWidth = 1024, localStorageEntries = {} }, run) {
  const previousWindow = global.window;
  const previousLocalStorage = global.localStorage;

  const storage = new Map(Object.entries(localStorageEntries));
  const localStorage = {
    getItem(key) {
      return storage.has(key) ? storage.get(key) : null;
    },
    setItem(key, value) {
      storage.set(key, String(value));
    },
    removeItem(key) {
      storage.delete(key);
    },
  };

  global.window = {
    innerWidth,
    addEventListener() {},
    removeEventListener() {},
    visualViewport: null,
    SpeechRecognition: undefined,
    webkitSpeechRecognition: undefined,
  };
  global.localStorage = localStorage;

  try {
    return run();
  } finally {
    if (previousWindow === undefined) delete global.window;
    else global.window = previousWindow;

    if (previousLocalStorage === undefined) delete global.localStorage;
    else global.localStorage = previousLocalStorage;
  }
}

function makeAssistantStateOptions(overrides = {}) {
  return {
    businessId: "biz-1",
    locale: "es-419",
    loadBusiness: async () => {},
    setActiveTab: () => {},
    setActiveInvoiceId: () => {},
    setSuccessNotice: () => {},
    setUndoAction: () => {},
    setParseError: () => {},
    setConfirmError: () => {},
    setQuickActionError: () => {},
    setInvoiceActionNotice: () => {},
    setPurchaseActionNotice: () => {},
    appendChatHistoryEntry: () => {},
    updateSupplierField: async () => {},
    updateClientField: async () => {},
    updateProduct: async () => {},
    deleteProduct: async () => {},
    updateInvoiceStatus: async () => {},
    downloadInvoicePdf: () => {},
    downloadPurchaseRequestPdf: () => {},
    setLatestPurchaseRequest: () => {},
    navigateFromUserAction: () => false,
    moneyFmt: (value) => String(value),
    t: (_en, es) => es,
    products: [],
    clients: [],
    manufacturers: [],
    invoices: [],
    latestPurchaseRequest: null,
    ...overrides,
  };
}

function captureAssistantState({ innerWidth = 390, localStorageEntries = {}, overrides = {} }) {
  const modulePath = "./src/app/dashboard/lib/hooks/useAssistantState";
  let snapshot;

  withBrowserGlobals({ innerWidth, localStorageEntries }, () => {
    const { useAssistantState } = loadModule(modulePath);
    function Probe() {
      snapshot = useAssistantState(makeAssistantStateOptions(overrides));
      return React.createElement("div", null, "probe");
    }

    renderToStaticMarkup(React.createElement(Probe));
  });

  return snapshot;
}

function makeAssistantInputProps(overrides = {}) {
  return {
    input: "",
    setInput: () => {},
    chatHistory: [],
    loadingParse: false,
    parseError: null,
    parseMissingField: null,
    quickActionError: null,
    successNotice: null,
    parsed: null,
    setParsed: () => {},
    parsedSaleChatCount: null,
    confirming: false,
    confirmError: null,
    setConfirmError: () => {},
    assistantReply: null,
    assistantStockDraft: null,
    setAssistantStockDraft: () => {},
    assistantStockSaving: false,
    assistantStockError: null,
    setAssistantStockError: () => {},
    assistantConfirmationRequest: null,
    assistantConfirmationSubmitting: false,
    assistantConfirmationError: null,
    openNewClientHelper: () => {},
    assistantQuestionContext: null,
    assistantInputHint: null,
    latestPurchaseRequest: null,
    latestPurchaseRequestPayload: undefined,
    purchaseActionNotice: null,
    setPurchaseActionNotice: () => {},
    downloadingPurchaseRequestId: null,
    saleDraftRef: { current: null },
    business: { currency: "ARS" },
    handleMissingFieldSubmit: () => {},
    handleCustomerSelect: () => {},
    customerSelectContext: null,
    handleEditParsedSale: () => {},
    handleCancelParsedSale: () => {},
    handleConfirm: () => {},
    handleConfirmAndSendWhatsapp: () => {},
    handleAssistantConfirmationConfirm: () => {},
    handleAssistantConfirmationCancel: () => {},
    handleAssistantStockDraftDismiss: () => {},
    handleAssistantStockSubmit: () => {},
    updateAssistantStockField: () => {},
    updateAssistantStockItem: () => {},
    downloadPurchaseRequestPdf: () => {},
    sendPurchaseRequestToSupplier: async () => {},
    moneyFmt: (value) => String(value),
    t: (_en, es) => es,
    handleGo: () => {},
    clients: [],
    onManualSale: undefined,
    ...overrides,
  };
}

function renderAssistantInputMarkup({ innerWidth = 390, overrides = {} }) {
  let html = "";

  withBrowserGlobals({ innerWidth }, () => {
    const { AssistantInput } = loadModule("./src/app/dashboard/components/AssistantInput.tsx");
    html = renderToStaticMarkup(React.createElement(AssistantInput, makeAssistantInputProps(overrides)));
  });

  return html;
}

test("rehidrata una venta pendiente por cantidad desde localStorage en un remount", () => {
  const flow = {
    saleText: "Quiero vender una cinta métrica a Juan García",
    missingField: "quantity",
    answer: "Necesito la cantidad exacta para ajustar el stock.",
    inputHint: "Ej: 2 unidades",
  };

  const snapshotA = captureAssistantState({
    localStorageEntries: {
      "velora-pending-sale-flow": JSON.stringify(flow),
    },
  });
  const snapshotB = captureAssistantState({
    localStorageEntries: {
      "velora-pending-sale-flow": JSON.stringify(flow),
    },
  });

  assert.equal(snapshotA.assistantQuestionContext, "sale_missing_quantity");
  assert.equal(snapshotA.assistantReply, flow.answer);
  assert.equal(snapshotA.assistantInputHint, flow.inputHint);
  assert.equal(snapshotA.parseMissingField, null);
  assert.equal(snapshotB.assistantQuestionContext, "sale_missing_quantity");
  assert.equal(snapshotB.assistantReply, flow.answer);
});

test("rehidrata una venta pendiente por cliente con selector visible en un remount", () => {
  const flow = {
    saleText: "Quiero vender una cinta métrica",
    missingField: "customer",
    answer: "Todavía falta el cliente para completar esta venta. Decime el nombre completo o elegí un cliente existente.",
    inputHint: "Ej: Juan García",
    customerOptions: [
      { id: "c1", name: "Juan García" },
      { id: "c2", name: "María López" },
    ],
  };

  const snapshot = captureAssistantState({
    localStorageEntries: {
      "velora-pending-sale-flow": JSON.stringify(flow),
    },
  });

  assert.equal(snapshot.assistantQuestionContext, "sale_missing_customer");
  assert.equal(snapshot.assistantReply, flow.answer);
  assert.equal(snapshot.customerSelectContext?.saleText, flow.saleText);
  assert.deepEqual(
    snapshot.customerSelectContext?.clients.map((client) => client.name),
    ["Juan García", "María López"]
  );
});

test("el handleGo prioriza la venta pendiente recuperable antes de limpiar estado o caer al fallback", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "src/app/dashboard/lib/hooks/useAssistantState.ts"),
    "utf8"
  );
  const handleGoStart = source.indexOf("async function handleGo(");
  const handleGoEnd = source.indexOf("\n\n  function updateAssistantStockItem", handleGoStart);
  const handleGoBody = source.slice(handleGoStart, handleGoEnd);

  const recoverIndex = handleGoBody.indexOf("const activePendingSaleFlow = pendingSaleFlow ?? getRecoverablePendingSaleFlow();");
  const continueIndex = handleGoBody.indexOf("const handledPendingSale = await continuePendingSaleClarification(baseText, activePendingSaleFlow);");
  const clearIndex = handleGoBody.indexOf("setParseMissingField(null);");
  const rawInputIndex = handleGoBody.indexOf("const rawInput = assistantQuestionContext && continueAssistantTurn");

  assert.ok(recoverIndex >= 0, "Debe recuperar el pending sale flow antes de continuar.");
  assert.ok(continueIndex > recoverIndex, "Debe intentar continuar la venta pendiente después de recuperarla.");
  assert.ok(clearIndex > continueIndex, "No debe limpiar el estado pendiente antes de procesarlo.");
  assert.ok(rawInputIndex > continueIndex, "No debe entrar a la ruta genérica antes de intentar la continuación.");
});

test("las rutas de clientes mantienen la verdad durable tras crear, editar, borrar y releer", async () => {
  const { prisma, state } = createFakeContactsPrisma({
    customers: [],
    invoices: [
      {
        id: "inv-1",
        businessId: "biz-1",
        customerId: "cust-1",
        status: "issued",
        payloadJson: JSON.stringify({ customer: { name: "Juan García" } }),
      },
    ],
    sales: [
      {
        id: "sale-1",
        businessId: "biz-1",
        customerId: "cust-1",
      },
    ],
  });

  const route = loadModule("./src/app/api/customers/route.ts", makeRouteMocks(prisma));

  const createResponse = await route.POST(makeRequest({ name: "  juan cruz  ", phone: "1133445566" }));
  assert.equal(createResponse.status, 201);
  const createdBody = await createResponse.json();
  const createdId = createdBody.customer.id;
  assert.equal(state.customers.get(createdId).name, "Juan García");
  assert.equal(state.customers.get(createdId).phone, "1133445566");

  const afterCreateRefresh = Array.from(state.customers.values()).map((customer) => customer.name);
  assert.deepEqual(afterCreateRefresh, ["Juan García"]);

  const editResponse = await route.PATCH(makeRequest({
    id: createdId,
    name: "  juan cruz srl ",
    email: "ventas@juan.test",
  }));
  assert.equal(editResponse.status, 200);
  assert.equal(state.customers.get(createdId).name, "Juan García Srl");
  assert.equal(state.customers.get(createdId).email, "ventas@juan.test");

  const afterEditRefresh = Array.from(state.customers.values()).map((customer) => customer.name);
  assert.deepEqual(afterEditRefresh, ["Juan García Srl"]);

  state.invoices[0].customerId = createdId;
  state.sales[0].customerId = createdId;

  const deleteResponse = await route.DELETE(makeRequest({ id: createdId }));
  assert.equal(deleteResponse.status, 200);
  assert.equal(state.customers.has(createdId), false);
  assert.equal(state.invoices[0].customerId, null);
  assert.equal(state.sales[0].customerId, null);

  const afterDeleteRefresh = Array.from(state.customers.values()).map((customer) => customer.name);
  assert.deepEqual(afterDeleteRefresh, []);
});

test("las rutas de proveedores mantienen la verdad durable tras crear, editar, borrar y releer", async () => {
  const { prisma, state } = createFakeContactsPrisma({
    suppliers: [],
    mockPurchaseRequests: [
      {
        id: "req-1",
        businessId: "biz-1",
        supplierId: "sup-1",
        payloadJson: JSON.stringify({ supplier: { name: "Proveedor Uno" } }),
      },
    ],
  });

  const route = loadModule("./src/app/api/suppliers/route.ts", makeRouteMocks(prisma));

  const createResponse = await route.POST(makeRequest({ name: " proveedor uno ", email: "hola@proveedor.test" }));
  assert.equal(createResponse.status, 201);
  const createdBody = await createResponse.json();
  const createdId = createdBody.supplier.id;
  assert.equal(state.suppliers.get(createdId).name, "Proveedor Uno");
  assert.equal(state.suppliers.get(createdId).email, "hola@proveedor.test");

  const afterCreateRefresh = Array.from(state.suppliers.values()).map((supplier) => supplier.name);
  assert.deepEqual(afterCreateRefresh, ["Proveedor Uno"]);

  const editResponse = await route.PATCH(makeRequest({
    id: createdId,
    contactName: "Ana Proveedor",
    phone: "1122334455",
  }));
  assert.equal(editResponse.status, 200);
  assert.equal(state.suppliers.get(createdId).contactName, "Ana Proveedor");
  assert.equal(state.suppliers.get(createdId).phone, "1122334455");

  const afterEditRefresh = Array.from(state.suppliers.values()).map((supplier) => supplier.contactName);
  assert.deepEqual(afterEditRefresh, ["Ana Proveedor"]);

  state.mockPurchaseRequests[0].supplierId = createdId;

  const deleteResponse = await route.DELETE(makeRequest({ id: createdId }));
  assert.equal(deleteResponse.status, 200);
  assert.equal(state.suppliers.has(createdId), false);
  assert.equal(state.mockPurchaseRequests[0].supplierId, null);

  const afterDeleteRefresh = Array.from(state.suppliers.values()).map((supplier) => supplier.name);
  assert.deepEqual(afterDeleteRefresh, []);
});

test("las superficies de contactos recargan datos y limpian estados pendientes en create/edit/delete/cancel", () => {
  const contactsUISource = fs.readFileSync(
    path.join(process.cwd(), "src/app/dashboard/lib/hooks/useContactsUI.ts"),
    "utf8"
  );
  const contactsSource = fs.readFileSync(
    path.join(process.cwd(), "src/app/dashboard/lib/hooks/useContacts.ts"),
    "utf8"
  );
  const contactsTabSource = fs.readFileSync(
    path.join(process.cwd(), "src/app/dashboard/components/ContactsTab.tsx"),
    "utf8"
  );
  const dashboardSource = fs.readFileSync(
    path.join(process.cwd(), "src/app/dashboard/DashboardPage.tsx"),
    "utf8"
  );

  assert.match(contactsUISource, /await loadBusiness\(\);\s*markUpdated\("clients"\);/);
  assert.match(contactsUISource, /await loadBusiness\(\);\s*markUpdated\("suppliers"\);/);
  assert.match(contactsSource, /await loadBusiness\(\);\s*markUpdated\("clients"\);/);
  assert.match(contactsSource, /await loadBusiness\(\);\s*markUpdated\("suppliers"\);/);
  assert.match(contactsTabSource, /setShowSheet\(false\);/);
  assert.match(contactsTabSource, /setNewClient\(\(\) => EMPTY_CLIENT_DRAFT\);/);
  assert.match(contactsTabSource, /setNewSupplier\(\(\) => EMPTY_SUPPLIER_DRAFT\);/);
  assert.match(contactsTabSource, /setPendingDeleteId\(null\);/);
  assert.match(contactsTabSource, /onImportSuccess\(\); \/\/ reload/);
  assert.match(dashboardSource, /onImportSuccess=\{reloadData\}/);
});

test("el assistant screen renderizado no deja chip/card de respuesta, mantiene composer y oculta FAB en conflicto móvil", () => {
  const markup = renderAssistantInputMarkup({
    innerWidth: 390,
    overrides: {
      assistantReply: "Solo puedo ayudar con temas de negocio.",
      onManualSale: () => {},
    },
  });

  assert.match(markup, /assistant-composer-footer/);
  assert.doesNotMatch(markup, /class="assistant-thread-column w-full px-3 pt-2 pb-3 border-t bg-white\/50 backdrop-blur-sm shadow-inner"/);
  assert.doesNotMatch(markup, /\bRESPUESTA\b/);
  assert.doesNotMatch(markup, /Solo puedo ayudar con temas de negocio\./);
  assert.doesNotMatch(markup, /Nueva venta/);
});

test("el composer sigue después del panel funcional y el FAB se suprime cuando hay conflicto móvil real", () => {
  const markup = renderAssistantInputMarkup({
    innerWidth: 390,
    overrides: {
      customerSelectContext: {
        saleText: "Quiero vender una cinta métrica",
        clients: [{ id: "c1", name: "Juan García" }],
      },
      onManualSale: () => {},
    },
  });

  const panelIndex = markup.indexOf('class="assistant-thread-column');
  const composerIndex = markup.indexOf("assistant-composer-footer");

  assert.ok(panelIndex >= 0, "Debe renderizar el panel funcional cuando hay selector de cliente.");
  assert.ok(composerIndex > panelIndex, "El composer debe quedar montado después del panel funcional.");
  assert.doesNotMatch(markup, /Nueva venta/);
});

test("el assistant screen mantiene el FAB disponible en móvil cuando no hay conflicto", () => {
  const markup = renderAssistantInputMarkup({
    innerWidth: 390,
    overrides: {
      onManualSale: () => {},
    },
  });

  assert.match(markup, /assistant-composer-footer/);
  assert.match(markup, /Nueva venta/);
});
