/**
 * Maps supervisor action data (from supResult.actions[]) to CompoundAction
 * objects the client can dispatch. Only operational intents are mapped here —
 * rules/employees/policies are handled by their dedicated executors.
 */
import { normalizeForMatching } from "./shared";
import { guardSaleUnitPrice } from "./supervisor-action-mapper.money-guard";
import { dedupSupervisorActions } from "./supervisor-action-mapper.dedup";
import type { CompoundAction } from "./intent-handlers/types";

type CatalogProduct = { id: string; name: string; sku: string | null; price?: number | string | null };
type CatalogCustomer = { id: string; name: string };
type CatalogSupplier = { id: string; name: string };
type SupervisorAction = { intent: string; data: unknown; summary: string };

const OPERATIONAL_INTENTS = new Set([
  "register_sale", "edit_product", "bulk_price_update", "adjust_stock",
  "register_movement", "create_product", "delete_product",
  "stock_load", "create_customer", "edit_customer", "delete_customer", "create_supplier",
  "edit_supplier", "delete_supplier", "create_purchase_request", "return_sale",
  // create_budget ENCAJONADO 2026-05-25 — mapper handle (mapCreateBudget) stays
  // for reactivation. Restore by re-adding to this set.
  // employee.update / rename_employee / edit_employee: kept as defensive
  // catch-all so mapSingleAction returns null cleanly if the LLM emits them
  // (Equipo Agent is encajonado but the schema still allows the underlying
  // intents). NOT dead — without these the switch default would still drop
  // them, but the explicit entry makes the suppression auditable.
  "employee.update", "rename_employee", "edit_employee",
]);

function findById<T extends { id: string; name: string }>(
  name: unknown,
  catalog: T[],
): T | undefined {
  if (typeof name !== "string" || !name.trim()) return undefined;
  const needle = normalizeForMatching(name.trim());
  return catalog.find((item) => normalizeForMatching(item.name) === needle)
    ?? catalog.find((item) => normalizeForMatching(item.name).includes(needle))
    ?? catalog.find((item) => needle.includes(normalizeForMatching(item.name)));
}

function mapData(d: unknown): Record<string, unknown> {
  return d && typeof d === "object" ? (d as Record<string, unknown>) : {};
}

function mapRegisterSale(
  d: Record<string, unknown>,
  products: CatalogProduct[],
  customers: CatalogCustomer[],
  rawOwnerText: string,
): CompoundAction | null {
  const product = findById(d.productName, products);
  const customer = findById(d.customerName, customers);
  const qty = typeof d.qty === "number" && d.qty > 0 ? d.qty : undefined;

  // H-3 money-safety guard: strip LLM-invented unitPrice when it deviates from
  // catalog and owner text has no explicit price (see money-guard.ts for detail).
  // qty is passed so the guard can exclude the quantity number from the pool of
  // "prices the owner typed" — otherwise "vendé 2500 alfajores" lets an LLM that
  // copies the qty into unitPrice (2500) slip through.
  const unitPrice = guardSaleUnitPrice(d.unitPrice, product, rawOwnerText, qty);

  return {
    type: "register_sale",
    matchedProductId: product?.id ?? null,
    matchedCustomerId: customer?.id ?? null,
    autoSend: Boolean(d.autoSend),
    ...(qty !== undefined && { qty }),
    ...(unitPrice !== undefined && { unitPrice }),
  };
}

function mapEditProduct(d: Record<string, unknown>, products: CatalogProduct[]): CompoundAction {
  const product = findById(d.productName, products);
  // Emit even when not in snapshot — client resolves by name at execution time
  return {
    type: "edit_product",
    product: { id: product?.id ?? "", name: product?.name ?? String(d.productName ?? "") },
    field: String(d.field ?? "price"),
    value: String(d.value ?? ""),
  };
}

function mapAdjustStock(d: Record<string, unknown>, products: CatalogProduct[]): CompoundAction | null {
  const product = findById(d.productName, products);
  const mode = String(d.mode ?? "set");
  const quantity = Number(d.quantity ?? 0);
  // Bug 2 guard — quantity=0 is a no-op for increase/decrease; reject to avoid
  // polluting StockMovement and audit history with zero-unit writes.
  // mode="set" legitimately allows 0 (set stock to zero).
  if (quantity === 0 && (mode === "increase" || mode === "decrease")) {
    return null;
  }
  // Emit even when not in snapshot — client resolves by name at execution time
  return {
    type: "adjust_stock",
    product: { id: product?.id ?? "", name: product?.name ?? String(d.productName ?? "") },
    mode,
    quantity,
  };
}

function mapDeleteProduct(d: Record<string, unknown>, products: CatalogProduct[]): CompoundAction {
  const product = findById(d.productName, products);
  // Emit even when not in snapshot — client resolves by name at execution time
  return { type: "delete_product", product: { id: product?.id ?? "", name: product?.name ?? String(d.productName ?? "") } };
}

function mapBulkPriceUpdate(d: Record<string, unknown>): CompoundAction {
  return {
    type: "bulk_price_update",
    amount: Number(d.amount ?? 0),
    mode: String(d.mode ?? "percentage"),
    direction: String(d.direction ?? "up"),
    productIds: [],
    targetLabel: String(d.target ?? "todos los productos"),
  };
}

const MOVEMENT_TYPE_MAP: Record<string, string> = {
  // Spanish → English (safety net for model output drift)
  gasto: "purchase", ingreso: "income", sueldo: "salary", retiro: "adjustment", otro: "adjustment",
  // English passthrough
  purchase: "purchase", income: "income", salary: "salary", adjustment: "adjustment", tax: "tax",
};

function mapRegisterMovement(d: Record<string, unknown>): CompoundAction {
  const raw = String(d.movementType ?? "adjustment");
  return {
    type: "register_movement",
    movement: {
      movementType: MOVEMENT_TYPE_MAP[raw] ?? "adjustment",
      amount: Number(d.amount ?? 0),
      description: String(d.description ?? ""),
    },
  };
}

function mapCreateProduct(d: Record<string, unknown>): CompoundAction {
  return {
    type: "create_product",
    product: { name: String(d.name ?? ""), price: Number(d.price ?? 0), stock: Number(d.stock ?? 0) },
  };
}

function mapDeleteCustomer(d: Record<string, unknown>, customers: CatalogCustomer[]): CompoundAction | null {
  const c = findById(d.customerName, customers);
  // Guard: suppress when customer not found — empty id would reach DELETE /api/customers
  // and produce a 400/500. The agent answer already covers the not-found case.
  if (!c?.id) return null;
  return { type: "delete_customer", customer: { id: c.id, name: c.name } };
}

function mapCreateCustomer(d: Record<string, unknown>): CompoundAction {
  return {
    type: "create_customer",
    customer: {
      name: String(d.name ?? ""),
      phone: typeof d.phone === "string" ? d.phone : null,
      email: typeof d.email === "string" ? d.email : null,
      taxId: typeof d.taxId === "string" ? d.taxId : null,
      dni: typeof d.dni === "string" ? d.dni : null,
      address: typeof d.address === "string" ? d.address : null,
      postalCode: typeof d.postalCode === "string" ? d.postalCode : null,
      city: typeof d.city === "string" ? d.city : null,
    },
  };
}

function mapCreateSupplier(d: Record<string, unknown>): CompoundAction {
  return {
    type: "create_supplier",
    supplier: {
      name: String(d.name ?? ""),
      phone: typeof d.phone === "string" ? d.phone : "",
      email: typeof d.email === "string" ? d.email : "",
      contactName: typeof d.contactName === "string" ? d.contactName : "",
    },
  };
}

function mapStockLoad(d: Record<string, unknown>): CompoundAction {
  return {
    type: "stock_load",
    draft: {
      items: [{
        itemName: String(d.itemName ?? ""),
        quantity: typeof d.quantity === "number" ? d.quantity : null,
        unitPrice: typeof d.unitPrice === "number" ? d.unitPrice : null,
      }],
      supplierName: String(d.supplierName ?? ""),
    },
  };
}

// ENCAJONADO 2026-05-25 — mapCreateBudget unreachable because create_budget
// was removed from OPERATIONAL_INTENTS (Presupuestos feature parqueado).
// Function preserved for reactivation: re-list create_budget in
// OPERATIONAL_INTENTS + uncomment the case in mapSingleAction switch.
function mapCreateBudget(d: Record<string, unknown>, products: CatalogProduct[]): CompoundAction {
  const rawItems = Array.isArray(d.items) ? d.items : [];
  const items = rawItems.map((item: unknown) => {
    const i = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    const name = String(i.name ?? "");
    const match = findById(name, products);
    return {
      productId: match?.id ?? null,
      name: match?.name ?? name,
      quantity: Number(i.quantity ?? 1),
      unitPrice: typeof i.unitPrice === "number" ? i.unitPrice : null,
    };
  });
  return {
    type: "create_budget",
    customerName: String(d.customerName ?? "Consumidor Final"),
    items,
    autoSendWhatsapp: Boolean(d.autoSendWhatsapp),
  };
}

function mapCreatePurchaseRequest(d: Record<string, unknown>): CompoundAction {
  return {
    type: "create_purchase_request",
    supplierName: typeof d.supplierName === "string" ? d.supplierName : null,
    itemName: String(d.itemName ?? ""),
    quantity: typeof d.quantity === "number" ? d.quantity : null,
    unitPrice: typeof d.unitPrice === "number" ? d.unitPrice : null,
  };
}

function mapSingleAction(
  action: SupervisorAction,
  products: CatalogProduct[],
  customers: CatalogCustomer[],
  suppliers: CatalogSupplier[],
  rawOwnerText: string,
): CompoundAction | null {
  if (!OPERATIONAL_INTENTS.has(action.intent)) return null;
  const d = mapData(action.data);
  switch (action.intent) {
    case "register_sale": return mapRegisterSale(d, products, customers, rawOwnerText);
    case "edit_product": return mapEditProduct(d, products);
    case "adjust_stock": return mapAdjustStock(d, products);
    case "delete_product": return mapDeleteProduct(d, products);
    case "bulk_price_update": return mapBulkPriceUpdate(d);
    case "register_movement": return mapRegisterMovement(d);
    case "create_product": return mapCreateProduct(d);
    case "create_customer": return mapCreateCustomer(d);
    case "delete_customer": return mapDeleteCustomer(d, customers);
    case "create_supplier": return mapCreateSupplier(d);
    case "edit_customer": {
      const c = findById(d.customerName, customers);
      // Guard: if the customer wasn't found in the catalog snapshot, suppress the
      // action entirely. An empty id would propagate to PATCH /api/customers and
      // produce a 500. The supervisor's own answer already covers the not-found case;
      // returning null here prevents the malformed action from reaching the client.
      if (!c?.id) return null;
      return { type: "edit_customer", customer: { id: c.id, name: c.name }, field: String(d.field ?? "name"), value: String(d.value ?? "") };
    }
    case "edit_supplier": {
      const s = findById(d.supplierName, suppliers);
      // Emit even when not in snapshot — client resolves by name at execution time
      return { type: "edit_supplier", supplier: { id: s?.id ?? "", name: s?.name ?? String(d.supplierName ?? "") }, field: String(d.field ?? "name"), value: String(d.value ?? "") };
    }
    case "delete_supplier": {
      const s = findById(d.supplierName, suppliers);
      // Emit even when not in snapshot — client resolves by name at execution time
      return { type: "delete_supplier", supplier: { id: s?.id ?? "", name: s?.name ?? String(d.supplierName ?? "") } };
    }
    case "stock_load": return mapStockLoad(d);
    case "create_purchase_request": return mapCreatePurchaseRequest(d);
    // create_budget ENCAJONADO 2026-05-25 — case kept as preserve-only.
    // Unreachable because create_budget not in OPERATIONAL_INTENTS. Restore
    // by uncommenting the call + re-listing the intent in the set above.
    // case "create_budget": return mapCreateBudget(d, products);
    case "return_sale": return { type: "undo", undoTarget: "sale", undoCount: typeof d.undoCount === "number" && d.undoCount > 1 ? Math.min(d.undoCount, 10) : 1 };
    // Graceful fallback: employee rename/update is not supported via chat.
    // Suppress silently — the supervisor's answer should direct the user to Settings.
    case "employee.update":
    case "rename_employee":
    case "edit_employee":
      return null;
    default: return null;
  }
}

export function mapSupervisorActionsToCompoundActions(
  actions: Array<SupervisorAction>,
  fullCatalogProducts: CatalogProduct[],
  fullCatalogCustomers: CatalogCustomer[],
  fullCatalogSuppliers: CatalogSupplier[],
  rawOwnerText = "",
): CompoundAction[] {
  const result: CompoundAction[] = [];
  for (const action of dedupSupervisorActions(actions)) {
    const mapped = mapSingleAction(action, fullCatalogProducts, fullCatalogCustomers, fullCatalogSuppliers, rawOwnerText);
    if (mapped) result.push(mapped);
  }
  return result;
}
