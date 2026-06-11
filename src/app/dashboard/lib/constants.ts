export const SELECTED_BUSINESS_STORAGE_KEY = "selectedBusinessId";
// Tab "team" + "budget" SHELVED 2026-05-25 (sin Companion no hay empleados,
// presupuestos parqueado). Quedan en el array para mantener TabKey union
// retrocompatible; secondaryTabs + QuickMenuPanel los esconden de la UI.
export const tabs = ["main", "sales", "inventory", "clients", "suppliers", "budget", "invoices", "team", "servicios", "settings", "conversations"] as const;
// Bottom nav (mobile): 4 tabs. Suppliers and Clients moved to QuickMenuPanel (3-dot overflow)
// Servicios promoted to primary slot 2026-05-20. Order: Home → Servicios → Sales → Inventory.
export const primaryTabs = ["main", "servicios", "sales", "inventory"] as const;
// Sidebar (desktop + mobile): secondary nav items shown after primaryTabs.
// clients appears first so it renders immediately below inventory.
// "team" SHELVED 2026-05-25. Restaurar "team" agregando antes de "settings".
// "conversations" — owner-only customer WhatsApp inbox (2026-05-29).
export const secondaryTabs = ["clients", "conversations", "settings"] as const;

// Employee-only nav: subset of tabs accessible to non-owner actors.
// inventory/clients are read-only for employees — edit actions
// are gated at the RBAC layer, not at the navigation level.
export const employeePrimaryTabs = ["main", "sales", "inventory", "clients"] as const;
export const employeeSecondaryTabs = ["settings"] as const;

