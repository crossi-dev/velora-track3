// Core domain types — no UI, no framework dependencies

export type { Sale, SaleItem, SaleStatus, ParsedSale, ParsedSaleItem } from "./sale";
export type { Product, ProductRow, StockMovement } from "./product";
export type { Customer } from "./customer";
export type { Supplier } from "./supplier";
export type { ContactRow } from "./contact";
export type { CashMovement, MovementType } from "./movement";
export type { Business, BusinessType } from "./business";
export type { BusinessRule, BusinessRuleKind } from "./business-rule";
export type { Employee, EmployeeRole } from "./employee";
export type { PurchaseRequest, PurchaseRequestItem, PurchaseRequestStatus } from "./purchase-request";
export type { Invoice, InvoiceType, InvoiceStatus } from "./invoice";
// OWNER_ONLY_INTENTS is intentionally NOT exported via the barrel — direct
// imports from "@/domain/role-contract" force callers to read the usage rules
// in that file. The set is canonical for enumeration (companion-rules-summary,
// blocked-intent UI) but never use it as a runtime RBAC guard — call
// canRoleExecuteIntent() instead.
export { ROLES, AGENT_FOR_ROLE, HIGH_RISK_ACTION_TYPES, canRoleExecuteIntent } from "./role-contract";
export {
  DomainError,
  InsufficientStockError,
  PriceOutlierError,
  ProductNotOwnedError,
  BusinessNotFoundError,
  CustomerNotFoundError,
  InvalidItemQuantityError,
} from "./errors";
export type { Role, AgentName, ActorRole, ActorContext } from "./role-contract";
export { EMPLOYEE_EVENT_PROTOCOL } from "./events";
export type {
  EmployeeEventType,
  EmployeeEventBase,
  LowStockEvent,
  ShiftStartEvent,
  ShiftEndEvent,
  CashAtRiskEvent,
  BulkImportCompletedEvent,
  ChatMessageEvent,
  CompanionResponseEvent,
  SupervisorQueryEvent,
  StockIngressRequestEvent,
  EmployeeEvent,
} from "./events";
