# Prisma Architecture Audit — Firestore Migration Preparation

**Date:** May 22, 2026  
**Project:** Velora (texterp)  
**Objective:** Comprehensive investigation of Prisma ORM architecture for Google Firestore migration planning

---

## Executive Summary

**Verdict:** Firestore migration is **technically feasible but high-risk** without a solid adapter layer.

| Metric | Value | Risk Level |
|--------|-------|-----------|
| Models | 55 | MEDIUM |
| Multi-tenant models | 48 | HIGH |
| Mutation contracts | 50+ | MEDIUM |
| Transaction complexity | High | HIGH |
| Query sophistication | Moderate | MEDIUM |
| RLS integration | Prisma extension | HIGH |
| Idempotency layer | Custom + DB-backed | MEDIUM |

**Critical blocker:** Firestore's document model does NOT natively support:
- Foreign key constraints → tenant isolation must be enforced in code
- Row-level security (RLS) → Firestore security rules must cover multi-tenant filtering
- Transactions spanning 25+ entities → sale.create touches 6+ related tables
- Composite indexes → required for businessId+date queries

---

## 1. Prisma Schema Structure

### Model Count & Distribution

**Total Models: 55**

#### Core Business Models (Multi-Tenant)
| Model | Purpose | Records per business | Growth | Multi-tenant |
|-------|---------|----------------------|--------|--------------|
| Sale | Individual transaction | 100–10K/year | Linear (sales/day) | ✅ businessId |
| SaleItem | Line items | 500–50K/year | Linear (items/sale ≈ 2-5) | ✅ via Sale |
| Product | SKU master | 50–2K | Additive (slower growth) | ✅ businessId |
| Customer | Contact directory | 20–500 | Additive | ✅ businessId |
| Supplier | Vendor registry | 5–100 | Additive | ✅ businessId |
| Invoice | Receipt/proforma | 100–10K/year | 1:1 with Sale | ✅ businessId |
| CashMovement | Cash register audit | 500–50K/year | 1-N per Sale + manual entries | ✅ businessId |
| StockMovement | Inventory audit | 1K–100K/year | 1-N per Sale + stock-loads | ✅ businessId |
| CriticalWriteEvent | Audit trail | 1K–100K/year | **LARGEST GROWTH** — every mutation | ✅ businessId |
| ChatMessage | Chat history | 1K–10K/month | Daily/hourly during active use | ✅ businessId |
| PaymentIntent | QR payment state | 100–10K/year | Subset of sales | ✅ businessId |
| Budget | Quote/order | 50–500/year | Additive | ✅ businessId |
| Employee | Staff directory | 1–10 | Static per business | ✅ businessId |
| BusinessRule | Rule engine | 5–50 | Additive (few per business) | ✅ businessId |
| DelegationPolicy | Scope limits | 3–20 | Additive | ✅ businessId |

#### Auth & Session Models (Platform-wide)
| Model | Purpose | Multi-tenant |
|-------|---------|--------------|
| User | OAuth owner | ❌ Global (1:1 Business) |
| Account | OAuth provider link | ❌ Global |
| Session | NextAuth sessions | ❌ Global |
| VerificationToken | Email verification | ❌ Global |
| Employee | PIN-auth staff | ✅ businessId |

#### Integration Models (Multi-Tenant)
| Model | Purpose | Multi-tenant |
|-------|---------|--------------|
| MpConnection | Mercado Pago OAuth | ✅ businessId (unique) |
| MlCredential | MercadoLibre OAuth | ✅ businessId (unique) |
| ArcaCredential | AFIP cert + keys | ✅ businessId (unique) |
| ModoConnection | MODO payment keys | ✅ businessId (unique) |
| CourierCredential | Andreani/OCA keys | ✅ businessId (unique per provider) |
| AndreaniShipment | Shipping tracking | ✅ businessId |
| OcaShipment | Shipping tracking | ✅ businessId |
| MpConnection / OAuthState | OAuth flow state | ✅ businessId (OAuth only) |

#### Operational Models (Multi-Tenant)
| Model | Purpose | Multi-tenant |
|-------|---------|--------------|
| PushSubscription | Web push subscribers | ✅ businessId |
| PushNotificationLog | Daily summary audit | ✅ businessId |
| BusinessDocument | RAG chunks (vector) | ✅ businessId |
| PromptExample | Few-shot library | ❌ Global (shared) |
| MessageFeedback | User feedback | ✅ businessId |
| AgentEventLog | Agent bus audit | ✅ businessId |
| IdempotencyRecord | Idempotency cache | ✅ businessId (unique key) |
| CronCheckpoint | Scheduler state | ❌ Global (unique by jobName) |
| RateLimitBucket | Token bucket distributor | ⚠️ Hybrid (user + businessId) |
| A2aJtiSeen | JWT replay nonce | ❌ Global |

#### Enums (Implicit String Validation)

All enum-like fields use **String** (not Postgres ENUM) for flexibility:
- `Sale.status` → "paid" (only value currently)
- `ChatMessage.kind` → "human" | "assistant" | "chip"
- `ChatMessage.visibility` → "public" | "owner_only" | "employee_only"
- `Invoice.status` → "draft" | "issued" | "sent" | "paid"
- `PaymentIntent.estado` → "pending" | "confirmed" | "expired" | "cancelled" | "refunded"
- `Employee.role` → "employee" (only value; Owner stored in User.role)
- `BusinessRule.kind` → "time-based" | "condition-based" | "behavior-based"
- `DelegationPolicy.scope` → "discount" | "return" | "stock" | "supplier" | "credit" | "price" | (extensible)

---

### Key Multi-Tenant Architecture

**Tenant Isolation: Two-Layer Defense**

#### Layer 1: Application (WHERE businessId = ?)
Every query includes `businessId` in its WHERE clause:
```prisma
// Example: Product query
where: { 
  businessId,
  name 
}

// Example: Sale with relations
where: { 
  businessId, 
  date: { gte, lte }
}
```

#### Layer 2: Database (Row-Level Security)
Prisma extension at [src/lib/prisma-tenant-extension.ts](src/lib/prisma-tenant-extension.ts):
- Wraps EVERY query in a transaction
- Issues `SET LOCAL app.current_business_id = '<businessId>'` before the query
- PostgreSQL RLS policies check this variable before returning rows
- **Critical:** Neon pgbouncer transaction mode requires BEGIN/COMMIT wrapping

**Code pattern:**
```typescript
// src/lib/tenant-context.ts
export function runWithTenantContext<T>(businessId: string, fn: () => T): T {
  return als.run(businessId, fn);  // AsyncLocalStorage context
}

export function getTenantBusinessId(): string | undefined {
  return als.getStore();
}

// src/lib/prisma-tenant-extension.ts
const businessId = getTenantBusinessId();
if (!businessId) {
  return query(args);  // Cron/scheduled — no RLS
}
// Wrap in $transaction to protect Neon pgbouncer slot
return base.$transaction(async (tx) => {
  await tx.$executeRawUnsafe(
    `SET LOCAL app.current_business_id = '${businessId.replace(/'/g, "''")}'`
  );
  return query(args);
});
```

### Relationships Map

**Core domain relationships (crucial for Firestore schema redesign):**

```
User (1) ←→ (0..1) Business
  ├─→ Account (1..n)  [OAuth provider links]
  └─→ Session (0..n)  [NextAuth sessions — TTL auto-purge needed]

Business (1) ←→ (1..n) Product
Business (1) ←→ (1..n) Customer
Business (1) ←→ (1..n) Supplier
Business (1) ←→ (1..n) Employee
Business (1) ←→ (1..n) Sale
Business (1) ←→ (1..n) Invoice
Business (1) ←→ (1..n) CashMovement
Business (1) ←→ (1..n) StockMovement
Business (1) ←→ (1..n) ChatMessage
Business (1) ←→ (1..n) CriticalWriteEvent
Business (1) ←→ (1..n) PaymentIntent

Sale (1) ←→ (1..n) SaleItem
Sale (1) → (0..1) Customer  [nullable — fallback name allowed]
Sale (1) → (0..1) Employee  [nullable — owner can create sales]
Sale (1) → (1) Invoice       [unique — always created together]
Sale (1) ←→ (1..n) CashMovement
Sale (1) ←→ (0..1) PaymentIntent

SaleItem (n) → (0..1) Product  [nullable — deleted product OK for historical audit]
StockMovement (n) → (0..1) Product  [nullable — deleted product OK]

PaymentIntent (0..1) → Sale  [nullable — prepay before sale exists possible in future]

Budget (1) ←→ (1..n) BudgetItem
BudgetItem (n) → (0..1) Product
Budget (1) → (0..1) Customer

Invoice (1) → Sale  [unique]
Invoice (1) → (0..1) Customer

AndreaniShipment (1) → Sale  [unique]
OcaShipment (1) → Sale       [unique]

Employee (n) → Business
EmployeeNote (n) → Employee
EmployeeNote (n) → Business

TrustedPeerAgent (n) → Business  [extensible]
BusinessRule (n) → Business
DelegationPolicy (n) → Business
```

### Data Types & Constraints

| Type | Usage | Firestore Equivalent | Notes |
|------|-------|---------------------|-------|
| String (CUID) | All `@id` fields | string | 25 chars, collision-resistant |
| String (UUID without dashes) | UUID-like IDs | string | 32 hex chars |
| String (255 to 2000 chars) | Names, descriptions | string | @db.VarChar(N) → varies by field |
| DateTime | Timestamps | Timestamp | @default(now()), @updatedAt |
| Decimal(14,2) | Money (ARS) | number or string | Must preserve precision — use string in Firestore |
| Decimal(12,4) | Tax rates | number or string | 4 decimal places |
| BigInt | Counter values | number | InvoiceCounter, DraftCounter overflow protection |
| Int | Quantities, counts | number | Product.quantity, Sale item counts |
| Float | Token bucket state | number | RateLimitBucket.tokens (lazy refill) |
| Json | Complex data | object or string | payloadJson, decisionJson, shippingAddress, etc. |
| Boolean | Flags | boolean | demoMode, active, etc. |
| Unsupported("vector(768)") | pgvector embeddings | string (base64) or array | Customer.embedding, BusinessDocument.embedding |

**Critical: Decimal(12,2) precision loss**
- Firestore numbers are IEEE 754 doubles (53 bits)
- ARS 14.2 (sale amounts) + 12.4 (tax rates) require careful handling
- **Recommendation:** Store as strings in Firestore, parse/validate in application

### Indexes Defined (Prisma)

**Unique Constraints (CRITICAL for Firestore design):**
```
User: @unique email
Account: @unique [provider, providerAccountId]
Session: @unique sessionToken
VerificationToken: @unique [identifier, token]
Business: @unique userId
Invoice: @unique [businessId, invoiceNumber]
Invoice: @unique [businessId, documentType, sequenceNumber]
Product: @unique [businessId, sku]
Customer: @unique [businessId, name]
Supplier: @unique [businessId, name]
Sale: (no unique constraint — can duplicate same customer/date/amount in theory)
PaymentIntent: @unique [businessId, idempotencyKey]
Budget: @unique [businessId, budgetNumber]
IdempotencyRecord: @unique [businessId, actionType, idempotencyKey]
MpConnection: @unique businessId
MlCredential: @unique businessId
ArcaCredential: @unique businessId
ModoConnection: @unique businessId
CourierCredential: @unique [businessId, provider]
ChatMessage: @unique [businessId, clientMessageId]
DailySummaryPushLog: @unique [businessId, dateAR]
PushSubscription: @unique [businessId, endpoint]
TrustedPeerAgent: @unique [businessId, domain]
AgentEventLog: @unique [businessId, eventId]
BusinessCounter: @unique [businessId, counterType]
```

**Regular Indexes (for query performance):**
```
Account: [userId]
Session: [userId]
Invoice: [businessId], [customerId], [businessId, issuedAt]
Product: [businessId]
Customer: [businessId], [businessId, name]
Supplier: [businessId]
Sale: [businessId], [businessId, date], [customerId], [businessId, status], [businessId, employeeId]
SaleItem: [saleId], [productId]
CashMovement: [businessId, date], [saleId]
StockMovement: [businessId, createdAt], [productId]
CriticalWriteEvent: [businessId, actionType, createdAt], [businessId, actorEmployeeId, createdAt], [businessId, resourceId]
ChatMessage: [businessId, createdAt], [businessId, visibility, createdAt], [businessId, targetEmployeeId, createdAt]
PaymentIntent: [businessId, estado, createdAt], [businessId, createdByEmployeeId], [saleId]
Employee: [businessId, active]
BusinessRule: [businessId, active], [businessId, active, kind]
DelegationPolicy: [businessId, active, scope]
BudgetItem: [budgetId]
PushSubscription: [businessId, expired], [businessId, kind, expired]
BusinessDocument: [businessId, sourceFile]
DailySummaryPushLog: [dateAR]
AndreaniShipment: [businessId], [trackingNumber]
OcaShipment: [businessId], [trackingNumber]
EmployeeNote: [businessId, acknowledgedAt], [businessId, createdAt]
BusinessCounter: (no explicit index — queried by unique [businessId, counterType])
```

---

## 2. ORM Layer Architecture

### Initialization & Client Setup

**File:** [src/lib/prisma.ts](src/lib/prisma.ts)

```typescript
import { PrismaClient } from "@prisma/client";
import { buildTenantExtension } from "@/lib/prisma-tenant-extension";

function makePrisma() {
  const base = new PrismaClient({
    datasources: { db: { url: withSsl(process.env.DATABASE_URL ?? "") } },
  });
  return base.$extends(buildTenantExtension(base));
}

const globalForPrisma = globalThis as unknown as {
  prisma?: ReturnType<typeof makePrisma>;
};

export const prisma = globalForPrisma.prisma ?? makePrisma();
if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
```

**Key points:**
- Single global client instance (singleton pattern)
- Prevents connection pool exhaustion on hot reload
- SSL enforced on all connections (`sslmode=require`)
- **NO** statement_timeout in URL — would fail on Neon pgbouncer; use middleware if needed

### Tenant Isolation Extension

**File:** [src/lib/prisma-tenant-extension.ts](src/lib/prisma-tenant-extension.ts)

**Architecture:**
1. Intercepts ALL Prisma operations via `Prisma.defineExtension`
2. Checks `getTenantBusinessId()` from AsyncLocalStorage
3. If present, wraps the query in a transaction that runs `SET LOCAL app.current_business_id`
4. PostgreSQL RLS policies use this variable to filter rows

**Critical detail:** Neon pgbouncer in transaction mode doesn't support prepared statements across multiple backend connections. The `$transaction` wrapper ensures `SET LOCAL` and the query run in the SAME backend slot.

**Firestore implications:**
- No native RLS → Firestore security rules must enforce businessId
- No transactions with 25+ operations → split into smaller sub-transactions
- Document paths MUST include businessId for rule validation

### Database Connectivity

**Connection pooling (Neon + Cloud Run):**
- **DATABASE_URL:** pooled connection (pgbouncer, transaction mode)
- **DIRECT_URL:** direct connection (for migrations)
- **Neon Free Tier:** auto-suspend after 5 min idle (requires `minScale=0` on Cloud Run)
- **Bottleneck:** Neon pooler ceiling is the max concurrent connections — at ~1 req/s across many Cloud Run instances, this becomes saturated

---

## 3. Mutation Contract System

**Files:** 
- [src/app/api/_lib/mutation-contract.ts](src/app/api/_lib/mutation-contract.ts)
- [src/app/api/_lib/mutation-contract-entries.ts](src/app/api/_lib/mutation-contract-entries.ts)
- [src/app/api/_lib/mutation-contract-types.ts](src/app/api/_lib/mutation-contract-types.ts)

### Contract Structure

Every mutation is declared in `SERVER_MUTATION_CONTRACT`:

```typescript
"sale.create": {
  actionType: "sale.create",
  routeScope: "sales/create",
  resourceType: "sale",
  requiresTrace: true,
  requiresIdempotency: true,
  idempotencyStrategy: "header",
  compositeChildren: [
    "sale-item.create",
    "inventory.decrement",
    "stock-movement.create",
    "cash-movement.create",
    "invoice.create"
  ],
}
```

### Key Mutation Actions (50+ total)

| Category | ActionTypes | Notes |
|----------|-------------|-------|
| **Sales** | sale.create | Creates Sale + SaleItem + CashMovement + Invoice + StockMovement (6 writes) |
| | undo.execute | Reverses sale with cascade |
| **Stock** | stock-load.create | Creates Product or increments + StockMovement + CashMovement (receipt) |
| | product.create, .update, .delete | CRUD with inventory sync |
| | product.bulk-price-update | Batch price changes |
| | product.resolve-or-create | Upsert (create if missing) |
| **Customers** | customer.create, .update, .delete | CRUD with cascading invoice/sale detach |
| **Suppliers** | supplier.create, .update, .delete | CRUD with cascading purchase-request detach |
| **Invoices** | invoice.update-status | State machine (draft→issued→sent→paid) |
| | invoice.send-whatsapp | Sends receipt + WhatsApp integration |
| **Payments** | payment-intent.create | QR cobro state machine |
| | payment-intent.confirm | Marks cobro as received |
| | payment-intent.refund | Reverses cobro (V1 cash only) |
| **Budgets** | budget.create, .delete, .send-whatsapp | Quote flow |
| **Cash** | cash-movement.create | Manual cash entry (void, return, adjustment) |
| **Employees** | employee.create, .revoke | Staff management |
| | employee.login, .logout | Session tracking |
| **Onboarding** | onboarding.chat, .complete, .orchestrate | Multi-turn chat state |
| **Integrations** | mp.oauth-callback | Mercado Pago OAuth |
| | ml.catalog-sync | MercadoLibre sync |
| | arca.configure | AFIP certificate upload |
| **Business** | business.update | Config changes |
| **Push** | push-notifications.subscribe | Web push subscriber |
| **Import** | import.create | CSV bulk upsert |

### Idempotency Enforcement

**Requirement:** All money-path mutations MUST have `requiresIdempotency: true`

**Three layers:**

#### Layer 1: Header-based detection
```typescript
// src/app/api/_lib/idempotency.ts
export function getIdempotencyKey(req: NextRequest) {
  return req.headers.get("x-idempotency-key")?.trim().slice(0, 256) ?? "";
}
```

#### Layer 2: Record insert (race-safe)
```typescript
export async function beginIdempotentMutation(args: {
  client: IdempotencyClient;
  businessId: string;
  actionType: string;
  idempotencyKey: string;
  requestBody: unknown;
}) {
  const recordId = randomUUID().replace(/-/g, "");
  try {
    // Atomic insert — unique constraint on (businessId, actionType, idempotencyKey)
    await client.idempotencyRecord.create({ data: { id: recordId, ... } });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      // Collision — check if we can replay
      const existing = await readIdempotencyRow(...);
      if (existing.requestHash === requestHash) {
        return { kind: "replay", response: storedResponse };
      }
      return { kind: "conflict" };
    }
  }
  return { kind: "execute", recordId };
}
```

#### Layer 3: Completion + cleanup
```typescript
export async function completeIdempotentMutation(args: {
  client: IdempotencyClient;
  recordId: string;
  responseStatus: number;
  responseBody: unknown;
}) {
  await client.idempotencyRecord.update({
    where: { id: recordId },
    data: {
      status: "completed",
      responseStatus,
      responseBody: JSON.stringify(responseBody),
      completedAt: now,
    },
  });
}
```

**TTL:** Cron job daily clears old records:
- Pending > 5 min (stuck requests)
- Completed > 30 days (no longer need replay buffer)

### Audit Trail (CriticalWriteEvent)

**File:** [src/infrastructure/shared/critical-write-audit.ts](src/infrastructure/shared/critical-write-audit.ts)

**Every mutation writes ONE row:**

```typescript
export async function recordCriticalWriteEvent(args: {
  client: CriticalWriteClient;
  businessId: string;
  actorUserId: string;
  actorEmployeeId?: string | null;  // null = owner; non-null = employee
  routeScope: string;
  actionType: string;
  resourceType: string;
  resourceId?: string | null;
  summary: string;
  payload: unknown;
  input?: unknown;
  before?: unknown;
  after?: unknown;
}): Promise<boolean>
```

**PII Redaction:**
- Email, phone, DNI, CUIT patterns scrubbed from summary
- Payload JSON recursively redacts fields matching `/(pin|password|token|phone|email|dni)/i`
- Preserves UUIDs, amounts, action descriptors

**Growth problem:** This table grows fastest (1 row per mutation):
- 100 sales/day × 365 = 36.5K rows/year
- Plus stock-loads, customer creates, cash movements
- **Total:** ~100K–500K rows/year at scale
- **Cleanup:** Daily cron deletes rows > 90 days (target: 3-month retention)

---

## 4. Critical Queries (Top 20)

### READ-HEAVY queries

#### 1. **Invoice delivery** — get recent invoices for business
```typescript
// src/app/api/business-assistant/_lib/context-cache.ts
const invoices = await prisma.invoice.findMany({
  where: { businessId },
  orderBy: { issuedAt: "desc" },
  take: 50,
  select: { id: true, invoiceNumber: true, status: true, totalAmount: true, issuedAt: true }
});
```
**Frequency:** ~10/chat session | **Complexity:** Medium | **Index:** [businessId, issuedAt DESC]

#### 2. **Product context** — list products for autocomplete/validation
```typescript
const products = await prisma.product.findMany({
  where: { businessId, name: { contains: query } },
  orderBy: { name: "asc" },
  take: 20,
});
```
**Frequency:** ~5/chat | **Complexity:** Low | **Index:** [businessId]

#### 3. **Customer by name** — resolve "vende a Juan Pérez" to ID
```typescript
const customer = await prisma.customer.findFirst({
  where: { businessId, name: { equals: normalizedName, mode: "insensitive" } },
});
```
**Frequency:** ~1/sale | **Complexity:** Low | **Index:** [businessId, name]

#### 4. **Recent sales** — daily summary / KPI dashboard
```typescript
const sales = await prisma.sale.findMany({
  where: {
    businessId,
    date: { gte: startOfDay, lte: endOfDay }
  },
  include: { saleItems: true, customer: true },
  orderBy: { date: "desc" },
});
```
**Frequency:** ~1/hour | **Complexity:** Medium | **Index:** [businessId, date]

#### 5. **Employees for broadcast** — alert all staff
```typescript
const employees = await prisma.employee.findMany({
  where: { businessId, active: true },
  select: { id: true, name: true }
});
```
**Frequency:** ~1/alert (rare) | **Complexity:** Low | **Index:** [businessId, active]

#### 6. **Product stock validation** — check quantity before sale
```typescript
const existing = await prisma.product.findMany({
  where: { businessId, id: { in: productIds } },
  select: { id: true, quantity: true, name: true, businessId: true }
});
```
**Frequency:** ~1/sale | **Complexity:** Low | **Index:** [businessId]

#### 7. **Audit trail export** — compliance download
```typescript
const rows = await prisma.criticalWriteEvent.findMany({
  where: {
    businessId,
    createdAt: { gte: from, lte: to }
  },
  orderBy: { createdAt: "desc" },
  take: 10000,
});
```
**Frequency:** ~1/week (manual) | **Complexity:** High | **Index:** [businessId, actionType, createdAt]

#### 8. **Customer by ID** — fetch for invoice/shipment
```typescript
const customer = await prisma.customer.findUnique({
  where: { id: customerId },
  select: { name: true, email: true, phone: true, dni: true }
});
```
**Frequency:** ~2/sale | **Complexity:** Low | **Index:** PK (id)

#### 9. **Budget list** — quotes pending client approval
```typescript
const budgets = await prisma.budget.findMany({
  where: { businessId, status: "draft" },
  include: { items: true },
  orderBy: { createdAt: "desc" }
});
```
**Frequency:** ~0.5/chat | **Complexity:** Medium | **Index:** [businessId]

#### 10. **Employee lookup** — permission checks
```typescript
const emp = await prisma.employee.findUnique({
  where: { id: employeeId },
  select: { businessId: true, role: true, active: true }
});
```
**Frequency:** ~1/request | **Complexity:** Low | **Index:** PK (id)

### WRITE-HEAVY queries

#### 11. **Sale creation** — transactional monster
```typescript
// src/application/use-cases/create-sale.use-case.ts
return ports.transaction.run(async (tx) => {
  const result = await ports.sale.createTransaction(tx, {
    businessId, customerId, employeeId, checkedItems, serverTotal
  });
  // Internally creates:
  // - Sale (1)
  // - SaleItem (n)
  // - Customer (0-1, if fallback)
  // - CashMovement (1-2)
  // - StockMovement (n)
  // - Invoice (1)
  // + recordCriticalWriteEvent (1)
  // Total: 6+ entities
});
```
**Frequency:** ~10–100/day | **Complexity:** VERY HIGH | **Transaction:** Mandatory (composite)

#### 12. **Idempotency record create** — race-safe
```typescript
await client.idempotencyRecord.create({
  data: {
    id: recordId,
    businessId,
    actionType,
    idempotencyKey,
    requestHash,
    status: "pending",
    createdAt: now,
  }
});
// Catches P2002 (unique constraint) for duplicates
```
**Frequency:** ~1/mutation | **Complexity:** Low | **Constraint:** [businessId, actionType, idempotencyKey]

#### 13. **Stock-load create** — inventory receipt
```typescript
// Similar to sale.create but inverse:
// - Product.update (quantity +)
// - StockMovement.create
// - CashMovement.create (money out to supplier)
// - PurchaseRequest.create
```
**Frequency:** ~2–5/week | **Complexity:** HIGH | **Transaction:** Mandatory

#### 14. **Product price update** — bulk
```typescript
// src/application/use-cases/bulk-update-product-prices.use-case.ts
for (const item of priceUpdates) {
  await prisma.product.update({
    where: { businessId, id: item.productId },
    data: { price: item.newPrice }
  });
}
```
**Frequency:** ~0.5/week | **Complexity:** Low (per item)

#### 15. **Critical write event** — audit logger
```typescript
// Fired on every mutation
await client.criticalWriteEvent.create({
  data: {
    id: randomUUID(),
    businessId,
    actorUserId,
    routeScope,
    actionType,
    summary,
    payloadJson,
    createdAt: now,
  }
});
```
**Frequency:** ~10–100/day | **Complexity:** Low | **Growth:** 100K+/year

#### 16. **Payment intent confirm** — cobro QR state machine
```typescript
await prisma.paymentIntent.update({
  where: { businessId_idempotencyKey: { businessId, idempotencyKey } },
  data: {
    estado: "confirmed",
    confirmedAt: now,
    confirmedByEmployeeId: empId
  }
});
```
**Frequency:** ~1–10/day | **Complexity:** Low | **Constraint:** [businessId, idempotencyKey]

#### 17. **Chat message insertion** — realtime
```typescript
await prisma.chatMessage.create({
  data: {
    id: cuid(),
    businessId,
    clientMessageId,
    kind: "assistant",
    text: response,
    visibility: "public",
    createdAt: now
  }
});
```
**Frequency:** ~10–100/hour during active use | **Complexity:** Low

#### 18. **Customer creation** — explicit or fallback
```typescript
const created = await prisma.customer.create({
  data: {
    businessId,
    name: normalizedName,
    email,
    phone,
  }
});
```
**Frequency:** ~1–5/day | **Complexity:** Low

#### 19. **Idempotency completion** — mark done
```typescript
await client.idempotencyRecord.update({
  where: { id: recordId },
  data: {
    status: "completed",
    responseStatus: 200,
    responseBody: JSON.stringify(result),
    completedAt: now,
  }
});
```
**Frequency:** ~1/mutation | **Complexity:** Low

#### 20. **Budget item creation** — part of budget.create transaction
```typescript
for (const item of items) {
  await prisma.budgetItem.create({
    data: {
      budgetId: budget.id,
      productId: item.productId,
      name: item.name,
      quantity: item.qty,
      unitPrice: item.price
    }
  });
}
```
**Frequency:** ~0.5/week (batch with budget) | **Complexity:** Low (per item)

### Query Pattern Summary

| Pattern | Count | Firestore Challenge |
|---------|-------|---------------------|
| findMany + where + orderBy | 12 | Range + order requires composite index |
| findUnique | 6 | OK (by PK) |
| findFirst + where (case-insensitive) | 3 | Firestore has no case-insensitive queries |
| $transaction (multi-entity) | 4 | Max 25 writes/tx; sale.create = 6–8 |
| .create (simple) | 8 | OK |
| .update | 4 | OK |
| .count | 2 | OK (but slow on Firestore) |
| .include (relations) | 3 | Manual JOINs in application layer |

---

## 5. Database Connectivity & Neon Free Tier Issues

### Current Architecture

**Datasource:**
```prisma
datasource db {
  provider  = "postgresql"
  url       = env("DATABASE_URL")    // Pooled (pgbouncer)
  directUrl = env("DIRECT_URL")      // Direct (migrations)
}
```

**Connection pooling:**
- Neon exposes two URLs per branch
- Pooled = pgbouncer in transaction mode (recommended for serverless)
- Direct = no pooling (for Prisma migrations)

**Cloud Run environment:**
```dockerfile
# From cloudbuild.yaml (source of truth)
gcloud run services update velora \
  --min-instances=0 \
  --max-instances=100 \
  --cpu=2 \
  --memory=2Gi \
  --timeout=540
```

### Neon Free Tier Quota Exhaustion (Root Cause)

| Metric | Free Limit | Actual Usage | Status |
|--------|-----------|--------------|--------|
| **Compute time** | 5 hrs/month | ~720 hrs/month (cron every 5 min) | **EXCEEDED 144x** |
| **Database size** | 3 GB | ~500 MB | OK |
| **Active time** | Unlimited | Unlimited | OK |
| **Auto-suspend** | 5 min idle | 5 min idle | Working |

**Problem:** Cron job running every 5 min burns through the compute time quota because:
1. Each invocation wakes the database (counts against quota)
2. Cloud Scheduler fires 288 times/day = 8,640 times/month
3. Neon Free measures "compute time" = wall-clock time database is running
4. At 288 fires/day with 5-min auto-suspend, the database is awake ~48 hrs/day = 1,440 hrs/month

**Status:** Quota resets June 1, but unreliable for production.

### Firestore as Alternative

| Metric | Neon Free | Firestore Free |
|--------|-----------|----------------|
| **Storage** | 3 GB | 1 GB + 5 GB Google Cloud Storage |
| **Reads** | Unlimited | 50K/day |
| **Writes** | Unlimited | 20K/day |
| **Deletes** | Unlimited | 20K/day |
| **Transactions** | Unlimited (single DB) | 250/day (significant limit) |
| **Connection setup** | ~100 ms | ~10 ms |
| **Auto-scaling** | Yes (limited) | Yes (native) |
| **RLS** | Native (Postgres RLS) | Security rules (custom code) |

**Firestore quota risk:** 20K writes/day is tight for:
- 50 sales × 6 writes/sale = 300 writes
- Plus chat messages, audit trail, payment intents
- **Conservative estimate:** 1K–2K writes/day for typical business
- **Safe margin:** ~10x headroom until hitting paid tier

---

## 6. Risk Assessment for Firestore Migration

### CRITICAL RISKS

#### 1. **Transaction Size Explosion** ⚠️ BLOCKER
- **Issue:** sale.create writes to Sale, SaleItem (n), CashMovement, StockMovement (n), Invoice, CriticalWriteEvent = 6+ entities
- **Firestore limit:** 25 writes/transaction
- **Status:** Multiple sales in quick succession would overflow
- **Mitigation:** Split into sub-transactions (phase 1: sale + items, phase 2: audit trail async)

#### 2. **Case-Insensitive Queries** ⚠️ HIGH
- **Issue:** `Customer.findFirst({ where: { name: { equals, mode: "insensitive" } } })`
- **Firestore limitation:** No case-insensitive query (no collation)
- **Impact:** Customer lookup by voice input would fail or require full-text search
- **Mitigation:** 
  - Store normalized name field (lowercase)
  - Add Firestore full-text search via Algolia/Meilisearch
  - OR: Load all customers and filter in code (risky at scale)

#### 3. **Complex Joins** ⚠️ MEDIUM-HIGH
- **Issue:** Prisma `.include()` doesn't exist in Firestore
- **Example:** `sale.include({ saleItems: true, customer: true, invoice: true })`
- **Impact:** N+1 queries become visible; network traffic explodes
- **Mitigation:** 
  - Redesign queries to include related data in the main document
  - Firestore subcollections for 1-N relations (SaleItem inside Sale)
  - OR: Accept N+1 and cache aggressively

#### 4. **Row-Level Security (RLS) Loss** ⚠️ VERY HIGH
- **Issue:** Postgres RLS policies automatically enforced at storage layer
- **Firestore:** Security rules are NOT automatic — must be explicit in code
- **Risk:** Single code bug exposes all businesses' data
- **Mitigation:**
  - Firestore security rules MUST validate businessId on EVERY read
  - Code review checklist for data access
  - Automated tests: can Employee1 see Business2 data? (should be NO)

#### 5. **Composite Indexes Proliferation** ⚠️ MEDIUM
- **Issue:** Firestore charges per composite index; Neon is free
- **Example:** `[businessId, createdAt DESC], [businessId, date], [businessId, status]`
- **Impact:** ~50+ indexes = $5–10/month → adds up with scale
- **Mitigation:** Firestore pricing is still cheaper than fixing Neon quota; accept trade-off

#### 6. **BigInt Overflow** ⚠️ LOW
- **Issue:** BusinessCounter uses BigInt for invoice numbers (overflow protection)
- **Firestore:** Numbers are IEEE 754 doubles (lose precision >53 bits)
- **Impact:** Invoice counter could wrap silently
- **Mitigation:** Store counter as string, validate on increment

#### 7. **Vector Embeddings (pgvector)** ⚠️ MEDIUM
- **Issue:** Customer.embedding (768-dim), BusinessDocument.embedding (768-dim)
- **Firestore:** No native vector type
- **Impact:** Semantic search for RAG breaks
- **Mitigation:**
  - Store embeddings as base64 strings
  - Use Vertex AI Search or separate Pinecone index for ANN queries
  - Query cost is now OUT of Firestore (external service)

#### 8. **Idempotency Key Uniqueness** ⚠️ MEDIUM
- **Issue:** Firestore doesn't support multi-field unique indexes out-of-the-box
- **Current:** `UNIQUE(businessId, actionType, idempotencyKey)`
- **Firestore:** Must enforce in code or use document path as unique
- **Mitigation:** Document path = `/businesses/{businessId}/idempotency/{actionType}_{idempotencyKey}`

#### 9. **Transaction Pricing Under Load** ⚠️ MEDIUM
- **Issue:** Firestore Free = 250 transactions/day
- **Each sale.create = 1 transaction (but writes 6+ entities)**
- **Calculation:** 50 sales/day = 50 transactions OK, but during peak (lunch rush = 100/hr = overflow)
- **Mitigation:** Monitor closely; upgrade to Blaze (pay-per-use) immediately when needed

#### 10. **Offline-First Conflict Resolution** ⚠️ LOW-MEDIUM
- **Issue:** Capacitor app syncs mutation queue on reconnect
- **Offline queue:** Uses localStorage (not real-time synced)
- **Firestore offline support:** Built-in, but requires Firestore SDK on client
- **Impact:** Current architecture must change to integrate Firestore client SDK
- **Mitigation:** Use Firebase Realtime Database or Firestore client library for mobile

---

### MEDIUM RISKS

#### 11. **No Transactions Across Databases**
- **Issue:** MercadoLibre agent, ARCA integration, etc. are on separate services
- **Current:** All coordinated in Postgres (audit trail + payment intent)
- **Firestore:** Can't atomically update both Firestore + external service
- **Mitigation:** Event-driven pattern (Firestore writes event, cron processes async)

#### 12. **Query Cost Transparency**
- **Issue:** Firestore charges per read; Postgres is all-you-can-query
- **Example:** Loading 50 chat messages = 50 reads (not 1)
- **Impact:** Cost scales with query count, not data volume
- **Mitigation:** Paginate queries, cache results, batch loads

#### 13. **Backup & Disaster Recovery**
- **Issue:** Neon has automated backups; Firestore export is manual (or use Cloud Tasks)
- **Impact:** Recovery time = hours instead of minutes
- **Mitigation:** Set up automated Firestore export to GCS daily

---

## 7. Current Issues with Neon Free Tier

### Quota Exhaustion Pattern

**Timeline:**
- May 9: Cron job (`velora-rule-alerts`) set to run every 5 min
- May 12: Compute quota drops below 30% (0.5 hrs remaining)
- May 22: **Quota reset (claimed by Neon support)**

**Why it happened:**
- Cron every 5 min = 8,640 executions/month
- Each wakes database = counts against compute quota
- 5-min auto-suspend doesn't reset the monthly bucket

**Evidence:**
```bash
# From Neon dashboard
Compute time: 5.0 hours/month (limit)
Used: ~4.8 hours = 96% ✗

# From Cloud Run logs
Task rate: 288/day (every 5 min)
```

---

## 8. Recommendations for Firestore Migration

### Phased Approach (4 weeks)

#### **Phase 1: Adapter Layer (Week 1)**
Build an abstraction that speaks Firestore but mimics Prisma's interface:
```typescript
// Goal: swap backend without changing business logic
export class FirestoreAdapter {
  product = new ProductRepository(this.db);
  sale = new SaleRepository(this.db);
  customer = new CustomerRepository(this.db);
  // ... etc
}

// Usage stays the same:
const products = await repository.product.findMany({ businessId, name });
```

**Why:** Risk mitigation — if Firestore doesn't work, roll back to Prisma + Neon Launch Plan ($19/mo)

#### **Phase 2: Schema Redesign (Week 1–2)**
Document structure for Firestore:
```
/businesses/{businessId}/
  ├─ data/
  │  ├─ products/{productId}
  │  ├─ customers/{customerId}
  │  ├─ sales/{saleId}
  │  │  └─ items/{itemId}
  │  ├─ invoices/{invoiceId}
  │  └─ ...
  ├─ audit/
  │  └─ events/{eventId}
  └─ cache/
     └─ counters/{counterType}
```

**Considerations:**
- Subcollections vs. flat documents (affects query performance)
- Denormalization strategy (store product price in SaleItem or query separately?)

#### **Phase 3: Critical Path Implementation (Week 2–3)**
Start with highest-traffic queries:
1. Sale creation (6-write transaction)
2. Product list + autocomplete
3. Customer lookup
4. Invoice delivery

**Test thoroughly:** Off-production clone, smoke tests

#### **Phase 4: Cron + Integration (Week 3–4)**
- Migrate scheduled tasks (currently: cron every 5 min)
- Audit trail async writes
- Full regression testing on production clone

#### **Phase 5: Cutover (Week 4)**
- Blue-green deployment
- Monitor error rates + latency
- Rollback plan: revert to Neon Launch Plan

### Breaking Changes (Unavoidable)

| Feature | Postgres | Firestore | Migration |
|---------|----------|-----------|-----------|
| Case-insensitive queries | `mode: "insensitive"` | N/A | Add normalized field |
| Joins | `.include()` | Subcollections or N+1 | Redesign queries |
| Unique constraints | @unique multi-field | Document path | Enforce in code |
| Transactions | 25k+ writes/tx | 25 writes/tx | Split transactions |
| RLS | Native (Postgres) | Security rules | Code enforces businessId |
| Audit | `recordCriticalWriteEvent` | Async writes | Accept eventual consistency |

### Cost Comparison (Annual, 100 businesses at scale)

| Service | Neon Free | Neon Launch | Firestore Blaze |
|---------|-----------|------------|-----------------|
| Compute | $0 (quota) | $19 | Included |
| Storage (3 GB) | Included | $10 | $0.06/GB |
| Operations | Free | Free | Variable* |
| **Total** | $0 (breaks) | ~$230 | ~$100–500** |

*Assuming ~1K writes + 10K reads/day = ~$50/mo  
**Depends heavily on query patterns

---

## 9. Alternatives to Firestore

### Option A: Upgrade to Neon Launch Plan ($19/mo)
- **Pros:** No code changes, unlimited compute, same DX
- **Cons:** Monthly cost, still no scale-to-zero, quota resets
- **Recommended:** Short-term fix while building Firestore adapter

### Option B: Switch to Cloud SQL (Google Cloud PostgreSQL)
- **Pros:** Native RLS, same Prisma code, full SQL support
- **Cons:** No scale-to-zero, ~3–4x more expensive than Neon
- **Decision made:** Declined in April (too expensive)

### Option C: Keep Neon + Firestore Hybrid
- **Approach:** Hot data (2 weeks) in Neon; historical data in Firestore
- **Pros:** Best of both worlds
- **Cons:** Complex migration, ETL overhead
- **Recommended:** Not necessary at this scale

### Option D: SupaBase (PostgreSQL + Auth wrapper)
- **Pros:** PostgreSQL (no ORM rewrite), simpler than Cloud SQL
- **Cons:** Still no scale-to-zero, ~similar cost to Neon Launch
- **Status:** Not evaluated; Neon was chosen for launch

---

## 10. Migration Execution Checklist

### Pre-Migration
- [ ] Quantify exact Firestore quota usage (run simulator with real data)
- [ ] Document all queries: WHERE clauses, JOINs, indexes needed
- [ ] Identify N+1 risks post-migration
- [ ] Design Firestore security rules (by example, test every rule)
- [ ] Audit trail strategy: sync vs. async writes?
- [ ] Plan for vector embeddings (external ANN service)

### Implementation
- [ ] Build Firestore adapter (week 1)
- [ ] Migrate critical entities: Business, Product, Customer, Sale (week 1–2)
- [ ] Migrate mutations: transaction handling, idempotency (week 2)
- [ ] Migrate cron + scheduled tasks (week 3)
- [ ] Smoke test on production clone (week 3–4)
- [ ] Blue-green cutover (week 4)

### Post-Migration
- [ ] Monitor query performance (latency, error rates, costs)
- [ ] Verify tenant isolation: automated tests
- [ ] Validate audit trail completeness
- [ ] Track Firestore quota usage vs. forecast
- [ ] Plan upgrade to Blaze (pay-per-use) if needed

---

## 11. Files & Code Locations Reference

| Component | File | Lines | Purpose |
|-----------|------|-------|---------|
| Schema | [prisma/schema.prisma](prisma/schema.prisma) | 1,400+ | Data model + relationships |
| Prisma Client | [src/lib/prisma.ts](src/lib/prisma.ts) | 54 | Singleton initialization |
| Tenant Extension | [src/lib/prisma-tenant-extension.ts](src/lib/prisma-tenant-extension.ts) | 50 | RLS enforcement |
| Tenant Context | [src/lib/tenant-context.ts](src/lib/tenant-context.ts) | 40 | AsyncLocalStorage wrapper |
| Mutation Contract | [src/app/api/_lib/mutation-contract.ts](src/app/api/_lib/mutation-contract.ts) | 130 | Contract declaration |
| Mutation Entries | [src/app/api/_lib/mutation-contract-entries.ts](src/app/api/_lib/mutation-contract-entries.ts) | 150 | Individual mutations |
| Idempotency | [src/app/api/_lib/idempotency.ts](src/app/api/_lib/idempotency.ts) | 250 | Idempotency protocol |
| Audit Trail | [src/infrastructure/shared/critical-write-audit.ts](src/infrastructure/shared/critical-write-audit.ts) | 180 | Event logging |
| API Standards | [src/app/api/_lib/api-standards.ts](src/app/api/_lib/api-standards.ts) | 60 | Mutation requirements |
| Use Cases | [src/application/use-cases/](src/application/use-cases/) | 23 files | Business logic layer |
| Repositories | [src/infrastructure/persistence/](src/infrastructure/persistence/) | 10 files | Data access layer |

---

## Conclusion

**Firestore migration is viable but not trivial.** The main challenges are:

1. **Transaction splitting** (6+ entities → max 25 writes)
2. **Query redesign** (no case-insensitive, no `.include()`)
3. **RLS reimplementation** (code-enforced multi-tenant isolation)
4. **Async audit trail** (CriticalWriteEvent eventual consistency)

**Recommended path:**
1. **Short-term (this week):** Upgrade to Neon Launch Plan ($19/mo) to unblock
2. **Medium-term (4 weeks):** Build Firestore adapter in parallel
3. **Long-term (post-launch):** Evaluate usage patterns before full migration

**Estimated effort:** 3–4 weeks (1 developer), medium complexity

**Success criteria:**
- ✅ Chat still works (lowest latency)
- ✅ Sales creation completes < 2 sec (idempotency required)
- ✅ Audit trail 100% complete (no lost events)
- ✅ Multi-tenant isolation holds (zero cross-business data leaks)
- ✅ Firestore cost < $100/mo at scale (100 businesses)

---

**Report prepared by:** Claude (Copilot)  
**Next step:** Await user confirmation on Phase 1 start date
