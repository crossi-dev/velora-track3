# Velora MCP — Data Handling & Data Minimization Disclosure

**Purpose:** This document supports directory submission to OpenAI (app-submission-guidelines) and Anthropic (step-8 data-handling disclosure). It describes, per tool pack, what data each tool collects, whether each field is task-essential, persistence model, and downstream recipients. A separate section covers restricted-data assessment.

**Scope:** 13 packs, 48 tools registered in `src/lib/mcp/server.ts` (plus `validate_cuit`, the always-on pure tool). The onboarding connect-token tools are scoped with the `?packs=` mitigation described below.

**Audit date:** 2026-06-08  
**Branch audited:** `feat/payment-link-wizard`

---

## 1. Per-Pack Tool Input / Persistence / Recipients Table

### 1.1 Pure pack — always-on

| Tool | Input fields | Task-essential? | Persistence | Recipients |
|------|-------------|-----------------|-------------|------------|
| `validate_cuit` | `cuit` (string) | Yes — the identifier to validate | **None.** Pure checksum computation; no DB write, no log of the value (verified: `parseCuit` in `src/lib/cuit.ts` is a pure synchronous function with zero I/O) | None |

### 1.2 Fiscal pack

| Tool | Input fields | Task-essential? | Persistence | Recipients |
|------|-------------|-----------------|-------------|------------|
| `get_fiscal_readiness` | _(none)_ | — | Read-only | None |
| `emit_invoice` | `customerCuit`, `amountARS`, `tipo` (A/B/C), `concept` (optional) | All essential for an ARCA-compliant invoice | Invoice record NOT written to Velora DB (MCP standalone path). Emission record written to ARCA/WSFE (external). `amountARS` and `tipo` are the minimum AFIP requires | ARCA/WSFE (Argentine tax authority) |
| `emit_nota` | `customerCuit`, `amountARS`, `tipo`, `kind`, `associatedInvoice` (tipo/ptoVta/nro), `concept` (optional) | All essential for AFIP NC/ND | Same as emit_invoice — no Velora DB row | ARCA/WSFE |

### 1.3 Payments pack

| Tool | Input fields | Task-essential? | Persistence | Recipients |
|------|-------------|-----------------|-------------|------------|
| `get_payment_intent_status` | `paymentIntentId` (optional) OR `customerName` (optional) | One of the two is required; both together narrow further | Read-only query of Velora `PaymentIntent` table. Optionally calls MP live status API | MercadoPago (read-only status poll) |
| `open_payment_link_wizard` | `description`, `customerId`, `items[]` (productId + quantity + optional unitPriceOverride) | All task-essential; customerId and productIds are pre-resolved opaque IDs | Side-effect-free render; no writes | None |
| `create_tracked_payment_link` | `customerId`, `items[]`, `description`, `expiresInDays` (optional, 1–30), `idempotencyKey` (wizard-generated UUID) | All essential; `expiresInDays` defaults to 3; `idempotencyKey` is wizard-supplied, never model-supplied | Creates: Sale + SaleItems + PaymentIntent + Invoice rows in Velora (Supabase). Calls MP Checkout Pro to create a preference. See audit-cleanup cron for TTL | MercadoPago (Checkout Pro preference) |
| `open_pending_orders` | _(none)_ | — | Read-only | None |
| `open_cobro_status` | `paymentIntentId` OR `customerName` | One required | Read-only | None |
| `open_delivery_receipt` | `paymentIntentId` OR `saleId` | One required | Read-only | None |

### 1.4 Logistica pack

| Tool | Input fields | Task-essential? | Persistence | Recipients |
|------|-------------|-----------------|-------------|------------|
| `quote_shipping` | `originPostalCode`, `destinationPostalCode`, `weightGrams`, `declaredValue` (optional) | All essential for a rate quote | No write | Andreani and/or OCA (rate APIs) |
| `create_shipment` | `provider`, `saleId`, `customerName`, `customerLastName` (opt), `customerAddress`, `customerAddressNumber` (opt / OCA required), `customerPostalCode`, `customerCity` (opt), `customerProvince` (opt / OCA required), `customerPhone` (opt), `customerDni` (opt / Andreani prod required), `service` (opt), `weightGrams` | All fields are either required by the courier or clearly optional and labeled; `customerDni` is courier-required in production (Andreani), not Velora-optional | Shipment record written to Velora DB; courier label created externally | Andreani or OCA |
| `track_shipment` | `trackingNumber`, `provider` | Both essential | Read-only | Andreani or OCA |
| `get_package_profile` | `productIds[]` (optional) OR _(all products)_ | Product IDs to profile | Read-only | None |

**Note on `customerDni`:** DNI is an Argentine national ID number. It is collected only because Andreani's production API rejects shipments without it. It is passed to Andreani and persisted in the Velora Shipment record. This is the minimum required for Andreani production labeling; it is not used for any other purpose. See restricted-data assessment in §2.

### 1.5 Ventas pack (read-only)

| Tool | Input fields | Task-essential? | Persistence | Recipients |
|------|-------------|-----------------|-------------|------------|
| `query_catalog` | `search` (optional substring filter) | Optional narrowing | Read-only | None |
| `open_catalog_selector` | `search` (optional) | Optional | Read-only | None |

### 1.6 Customer pack

| Tool | Input fields | Task-essential? | Persistence | Recipients |
|------|-------------|-----------------|-------------|------------|
| `find_customer` | `name` (optional), `phone` (optional) — at least one required | Minimum search inputs | Read-only | None |
| `upsert_customer` | `customerId` (opt, update path), `name` (opt), `phone` (opt), `email` (opt), `address` (opt), `postalCode` (opt), `city` (opt) | All optional on purpose; minimum: one identifying field | Customer record created/updated in Velora (Supabase) | None |
| `delete_customer` | `customerId` | Essential | Soft-delete / hard-delete depending on history | None |

### 1.7 Messaging pack

| Tool | Input fields | Task-essential? | Persistence | Recipients |
|------|-------------|-----------------|-------------|------------|
| `send_whatsapp_text` | `to` (phone), `text`, `mediaUrl` (optional) | All essential | No Velora DB write from this tool. Meta Cloud API call | Meta / WhatsApp (message delivery) |
| `send_whatsapp_template` | `to`, `templateName`, `components[]` (optional), `languageCode` (optional) | All essential | No Velora DB write from this tool | Meta / WhatsApp |

### 1.8 Catalog pack (write)

| Tool | Input fields | Task-essential? | Persistence | Recipients |
|------|-------------|-----------------|-------------|------------|
| `create_product` | `name`, `price`, `costPrice` (opt), `weightGrams` (opt), `initialStock` (opt, default 0) | All essential or optional for the product record | Product row in Velora (Supabase) | None |
| `edit_product` | `productId`, `name` (opt), `price` (opt), `costPrice` (opt/nullable), `stockQuantity` (opt) | At least one edit field required | Updates product row | None |
| `stock_load` | `productId` (opt), `itemName`, `supplierId` (opt), `supplierName` (opt), `quantity`, `unitPrice` (opt), `autoCreateProduct` (bool), `createPurchaseRequest` (bool) | All fields either required or purposefully optional | StockMovement + Product rows | None |
| `adjust_stock` | `productId`, `mode` (literal "set"), `quantity` | All essential | Updates product stock | None |
| `delete_product` | `productId` | Essential | Soft-archive or hard-delete | None |
| `bulk_price_update` | `amount`, `mode` (percent/fixed), `direction` (up/down/set), `productIds[]` (optional) | All essential; productIds scopes the update | Updates product price rows | None |

### 1.9 Supplier pack

| Tool | Input fields | Task-essential? | Persistence | Recipients |
|------|-------------|-----------------|-------------|------------|
| `list_suppliers` | `search` (optional) | Optional filter | Read-only | None |
| `create_supplier` | `name`, `phone` (opt), `email` (opt), `contactName` (opt), `leadTimeDays` (opt) | Name required; rest optional | Supplier row in Velora | None |
| `create_purchase_request` | `supplierId` (opt), `supplierName` (opt), `itemName`, `quantity`, `unitPrice` | At least supplierId or supplierName required | PurchaseRequest row | None |
| `edit_supplier` | `supplierId`, `name` (opt), `phone` (opt/nullable), `email` (opt/nullable), `contactName` (opt/nullable), `leadTimeDays` (opt/nullable) | supplierId required; at least one change | Updates Supplier row | None |
| `delete_supplier` | `supplierId` | Essential | Deletes Supplier row | None |

### 1.10 Sales pack

| Tool | Input fields | Task-essential? | Persistence | Recipients |
|------|-------------|-----------------|-------------|------------|
| `register_sale` | `items[]` (productId + quantity + optional unitPrice), `customerId` (opt), `paymentMethod` (opt), `requestId` (opt — dedup hint) | All essential; `unitPrice` optional and DB price used when omitted | Sale + SaleItems + CashMovement + Invoice rows (Supabase) | None |
| `register_movement` | `type`, `description`, `amount`, `date` (opt) | All essential; date defaults to now | CashMovement row | None |
| `register_promesa_sale` | `customerId`, `items[]`, `expectedAt`, `reason` (opt) | All essential except `reason` | Sale + Invoice + PaymentIntent (promesa) rows | None |
| `confirm_promesa_payment` | `paymentIntentId`, `expectedAt`, `reason` (opt) | All essential except `reason` | CashMovement created; best-effort WhatsApp + shipment | Meta / WhatsApp (best-effort receipt) |
| `settle_promesa_payment` | `originalPaymentIntentId`, `paymentMethod`, `amount` (opt), `reason` (opt) | `paymentIntentId` + `paymentMethod` required; `amount` defaults to original | CashMovement row | None |
| `return_sale` | `count` (opt, default 1), `cutoffHours` (opt, default 24) | Both optional with safe defaults | Reverses Sale + CashMovement + Invoice + SaleItem rows | None |

### 1.11 Caja pack

| Tool | Input fields | Task-essential? | Persistence | Recipients |
|------|-------------|-----------------|-------------|------------|
| `caja_consultar_saldo` | _(none)_ | — | Read-only | None |
| `caja_ciclo_caja` | `action` (abrir/cerrar), `monto`, `nota` (opt, max 500 chars) | All essential except `nota` | CajaSession row (open or close) | None |
| `caja_registrar_movimiento` | `tipo`, `monto`, `descripcion` (max 500 chars) | All essential | CashMovement row | None |

### 1.12 Reportes pack (read-only)

| Tool | Input fields | Task-essential? | Persistence | Recipients |
|------|-------------|-----------------|-------------|------------|
| `query_sales` | `metrica`, `preset` (opt), `from` (opt), `to` (opt), `customer_name` (opt), `limit` (opt, default 10) | All essential given the selected metric | Read-only | None |

### 1.13 Connection pack (read-only)

| Tool | Input fields | Task-essential? | Persistence | Recipients |
|------|-------------|-----------------|-------------|------------|
| `connection_status` | _(none)_ | — | Read-only | None |

### 1.14 Onboarding pack

| Tool | Input fields | Task-essential? | Persistence | Recipients |
|------|-------------|-----------------|-------------|------------|
| `connect_mercadopago` | `accessToken` (APP_USR-… string) | Essential — it is the credential being stored | Token validated against MP `/users/me`, then **AES-256-GCM encrypted** before being stored as `MpConnection.accessTokenCiphertext` (Supabase). Plaintext never persisted. CriticalWriteEvent emitted (audit). | MercadoPago (validation only — one GET /users/me call) |
| `connect_pedidosya` | `apiToken` (string) | Essential | Token **AES-256-GCM encrypted** (same cipher as MP, `src/infrastructure/crypto/mp-token-cipher.ts`) and stored as `BusinessChannelCredential.encryptedCredentials`. Plaintext never persisted. CriticalWriteEvent emitted. | None (no live preflight) |
| `connect_whatsapp` | `phone` (E.164) | Essential — the business WhatsApp phone to register | `Business.whatsappBusinessPhoneE164` field updated (Supabase). CriticalWriteEvent emitted. | None |
| `upload_catalog` | `products[]` (name + price, max 50 items) | All essential per product | Product rows created in Velora (Supabase) | None |
| `open_onboarding` | _(none)_ | — | Read-only render | None |

---

## 2. Restricted-Data Assessment

### 2.1 `connect_mercadopago.accessToken` — Live Credential in Tool Input

**Classification:** CREDENTIAL (live OAuth-style access token, `APP_USR-…` format).  
**Standard reference:** OpenAI app-submission-guidelines: "Never collect… credentials."

**Finding (HIGH):** `connect_mercadopago` accepts a live MercadoPago production access token as tool input. This is a credential.

**Encryption verification (confirmed in code):**
- `mp-connect-core.ts` line 106: `accessTokenCiphertext: encrypt(accessToken)` — the plaintext token is encrypted with AES-256-GCM before any DB write.
- The response returns only `{ ok: true, mpUserId }` — the token is never echoed back in tool output.
- The `CriticalWriteEvent` payload stores `{ mpUserId, scope }` only — no token value.
- The MP validation call uses the token as a Bearer header and discards it after the HTTP response (no logging of the token value).

**Conclusion:** The plaintext token is never persisted and never returned. The encryption is confirmed. However, the token still travels through the MCP transport as a tool argument, which is prohibited by the OpenAI submission standard for published connectors.

**Agreed mitigation (document-only — do NOT implement here):**  
The published v1 connector excludes the `onboarding` pack (credential-taking connect tools) via the `?packs=` connection parameter. The JD-confirmed v1 starter pack-set is `https://tools.somosvelora.com/api/mcp?packs=payments,messaging,customer,catalog,ventas,sales,caja,reportes,connection` (31 tools) — which also excludes `fiscal`, `logistica`, and `supplier` for the minimum-viable v1 (re-enabled post-approval). Integration setup happens through the Velora dashboard's Servicios tab, not through chat. This is confirmed by `connection_status` returning `connectMethod: "oauth"` and `connectUrl` deep-links for MercadoPago and WhatsApp — the dashboard OAuth flow never routes credentials through the MCP layer.

### 2.2 `connect_pedidosya.apiToken` — Credential in Tool Input

**Classification:** CREDENTIAL (API key / bearer token for a third-party delivery platform).  
**Same standard:** OpenAI "Never collect… credentials."

**Finding (HIGH — same as 2.1):** `apiToken` is a raw PedidosYa API token accepted as input.

**Encryption verification (confirmed in code):**
- `pedidosya-connect-core.ts` line 57: `encrypt(JSON.stringify(credentials))` — AES-256-GCM before any DB write.
- Response returns only `{ ok: true }` — no token echoed.
- No logging of the token value.

**Mitigation:** Same `?packs=` exclusion of `onboarding` pack as in 2.1.

### 2.3 `validate_cuit` — Argentine CUIT/CUIL (Tax/Labor ID)

**Classification:** GOVERNMENT IDENTIFIER (Argentine fiscal ID — Código Único de Identificación Tributaria / Laboral, used for both personal tax identity and corporate registration).

**Finding (LOW — by design, narrow function):**  
`validate_cuit` accepts a CUIT/CUIL number as input. This is an Argentine government-issued identifier.

**Precise framing confirmed in code:**
- `parseCuit` in `src/lib/cuit.ts` is a pure synchronous function. It performs a checksum computation and returns structured parse results.
- No DB write. No network call. No logging of the value (verified: no `console.log`, `cloudLog`, or Prisma calls anywhere in `cuit.ts`).
- The input value is reflected back in the response as `normalized` and `formatted` fields — this is necessary for the tool's purpose (showing the caller the canonical form of what they submitted).
- Tool is registered as `readOnlyHint: true, openWorldHint: false`.

**Framing for disclosure:** Validates an Argentine tax/labor identifier (CUIT/CUIL) by checksum computation only. The value is not persisted, not logged, and not transmitted to any third party. The response echoes the normalized form of the input — this is structurally necessary (the caller needs the canonical XX-XXXXXXXX-X format).

**Note on AFIP/fiscal tools:** `emit_invoice` and `emit_nota` also accept `customerCuit`. These are transmitted to ARCA/WSFE as required by Argentine law for electronic invoice emission. Retention at ARCA is governed by Argentine fiscal regulation, not by Velora.

### 2.4 Payment Card Data

**Finding (NONE — confirmed clean):**  
No tool in any pack accepts a payment card number, CVV, expiry date, or cardholder name.

The payment path works as follows:
- `create_tracked_payment_link` creates a MercadoPago Checkout Pro preference (via `velora-payment-link.ts`) and returns a `checkoutUrl`.
- Card entry happens entirely on MercadoPago's domain (Checkout Pro hosted page), completely off-platform.
- The `checkoutUrl` is placed in `structuredContent` (widget-only) and never in the `content` text the model reads, per the GATE-3 comment in `payment-link-mutations.ts` line 36.

### 2.5 `customerDni` in `create_shipment` — National ID Number

**Classification:** GOVERNMENT IDENTIFIER (Argentine DNI — Documento Nacional de Identidad).  
**Standard reference:** OpenAI: "Never collect… government IDs." — this field requires explicit justification.

**Finding (MEDIUM — operationally necessary, must be disclosed):**  
`create_shipment.customerDni` is an optional field that becomes required in practice when the chosen courier is Andreani in production mode. Andreani's production label API rejects shipment creation without the recipient DNI. The field is passed to Andreani and is also persisted in the Velora Shipment record.

**Minimization assessment:** The field IS task-essential when Andreani production mode is active. It cannot be removed without breaking Andreani shipment creation for real customers.

**Disclosure recommendation:** Disclose that `customerDni` is collected solely to satisfy Andreani's shipment API requirement, is transmitted to Andreani, and is persisted in the Velora Shipment record tied to that sale. It is not used for identity verification, credit scoring, or any purpose beyond courier labeling. If the packs published to the OpenAI connector exclude `logistica`, this field is not exposed. If `logistica` is included, this field must be disclosed.

---

## 3. Over-Collection Assessment

### 3.1 `register_movement.description` — free-text field (LOW)

The `description` field is a free-text string (no max length in the Zod schema, though the DB column may enforce one). A caller could theoretically include sensitive information. No code change is needed — the field is semantically required to describe the movement and serves an audit function. Recommend: add `max(500)` to the Zod schema to match `caja_registrar_movimiento.descripcion` discipline.

**Severity:** LOW. Business operator context; not customer PII.

### 3.2 `caja_ciclo_caja.nota` and `caja_registrar_movimiento.descripcion` — free-text (LOW, already bounded)

Both already have `max(500)` — adequately bounded.

### 3.3 `register_promesa_sale.reason` / `confirm_promesa_payment.reason` / `settle_promesa_payment.reason` — free-text (LOW)

Optional human notes. No max length set. These are internal business notes, not customer-facing. Recommendation: add `max(500)` for consistency.

### 3.4 No conversation history or session IDs in tool inputs (CLEAN)

No tool accepts prior conversation context, session identifiers, or transcript content. MCP transport is stateless. Clean.

---

## 4. Response Minimization Spot-Check

Five tools spot-checked:

| Tool | Response fields | Assessment |
|------|----------------|------------|
| `validate_cuit` | `valid`, `normalized`, `formatted`, `prefix`, `body`, `checkDigit`, `personType`, `personTypeDescription`, `error` (opt) | All fields are computed results of the validation. `body` (the 8-digit taxpayer number) is echoed back — necessary since the caller needs it for invoice forms. Clean. |
| `find_customer` | `id`, `name`, `phone`, `email`, `address`, `postalCode`, `city`, `total` | Exact match of what downstream tools (upsert, register_sale) need. No internal timestamps, internal DB metadata, or session IDs. Clean. |
| `get_payment_intent_status` | `paymentIntentId`, `status`, `providerRef` (opt), `currency` | Minimal. No internal DB row timestamps or unrelated metadata. Clean. |
| `create_tracked_payment_link` | Content text: `"Listo, generé el link de cobro."` (plain string). `structuredContent`: `paymentLinkUrl`, `paymentIntentId`, `amountARS`, `currency` | Notably clean: the checkout URL is placed in `structuredContent` (widget-only, not readable by the model's text channel), per the GATE-3 design note. The model cannot misread or echo the URL. |
| `query_sales` (`ventas_periodo`) | `period`, `saleCount`, `totalRevenue`, `totalRevenueFormatted` | No line-item detail, no customer names, no product names at this aggregation level. Clean. |

---

## 5. Persistence Summary

All Velora records write to Supabase Postgres (free tier, `aws-1-us-west-2.pooler.supabase.com`). Retention is governed by:

- **Financial records** (`Sale`, `SaleItem`, `Invoice`, `CashMovement`, `PaymentIntent`): no automated TTL currently; governed by business data retention obligations. TTL for `CriticalWriteEvent` and `Session` rows is handled by the `audit-cleanup` cron.
- **`StockMovement`, `CashMovement` audit rows**: `audit-cleanup.ts` implements TTL via `deleteMany` (currently unbatched — see known gap in CLAUDE.md).
- **`MpConnection.accessTokenCiphertext`**: retained until the business reconnects (upsert overwrites). No standalone TTL.
- **`BusinessChannelCredential.encryptedCredentials`**: same as above.
- **`Shipment` records** (includes `customerDni` when provided): no automated TTL; governed by courier SLA and business retention obligations.

For OpenAI/Anthropic disclosure: Velora does not sell or share personal data with third parties beyond what is operationally required (MercadoPago for payments, Andreani/OCA for shipments, Meta for messaging, ARCA for invoicing). All third-party data transmission is described in the Recipients column in §1.

---

## 6. Summary of Findings by Severity

| ID | Severity | Tool(s) | Finding | Disposition |
|----|----------|---------|---------|-------------|
| F-1 | **HIGH** | `connect_mercadopago` | Live MP access token accepted as tool input — prohibited in published connector | Doc-only: exclude `onboarding` pack via `?packs=` for published OpenAI connector |
| F-2 | **HIGH** | `connect_pedidosya` | PedidosYa API token accepted as tool input — same prohibition | Doc-only: same `?packs=` exclusion |
| F-3 | **MEDIUM** | `create_shipment` | `customerDni` is an Argentine national ID — must be disclosed when `logistica` pack is published | Disclosure in this document; consider excluding `logistica` from the public connector if courier DNI collection is disqualifying |
| F-4 | **LOW** | `validate_cuit` | CUIT/CUIL is a government ID — must be framed accurately | Framed in §2.3: pure function, zero persistence, structurally necessary echo |
| F-5 | **LOW** | `register_movement`, `register_promesa_sale`, `confirm_promesa_payment`, `settle_promesa_payment` | Free-text note/description fields have no `max()` constraint | Recommend adding `max(500)` to Zod schemas for consistency; not a data-collection issue |
| F-6 | N/A (clean) | All tools | No payment card data collected anywhere in MCP surface | Confirmed clean |
| F-7 | N/A (clean) | All tools | No raw credentials echoed in any tool response | Confirmed clean |

---

## 7. Code Changes Made

**None.** This document is a read-only audit deliverable. No source files were modified.

F-5 (missing `max()` constraints) was noted but not applied — the audit instruction was to flag over-collection but not to broadly refactor. These are one-line Zod additions and can be applied in a dedicated commit.
