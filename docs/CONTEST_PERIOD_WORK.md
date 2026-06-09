# Contest Period Work — Google AI Agents Challenge Track 3

**Submission**: Velora — Refactor for Google Cloud Marketplace & Gemini Enterprise  
**Contest Period**: April 22, 2026 → June 5, 2026  
**Per email confirmation with a Google contact, April 29, 2026 (Option A approved)**

This document delineates the work authored during the official Contest Period as part of Velora's submission to Track 3 of the Google AI Agents Challenge. Velora itself is a pre-existing Argentine chat-first multi-agent platform. The work below represents the multi-agent orchestration layer, ADK integration, A2A protocol implementation, Vertex AI / Agent Engine deployment, security hardening, and supporting refactoring built specifically for this contest.

---

## Summary

- **Total commits (contest period)**: 1,422 commits (22 April – 14 May 2026, ongoing to 5 June 2026)
- **Files created (new)**: ~577 TS/TSX files + supporting infrastructure (migrations, scripts, tests, docs)
- **Files modified**: ~829 files across codebase
- **Lines of code impact**: Estimated 200K+ lines across implementation, tests, and migrations

---

## Track 3 Mandate Compliance

### B2B Focus
Velora is architected for **B2B enterprise**: Owner (Supervisor role, runs Gemini 2.5 Pro) manages the business and receives AI-driven insights; Employees (Companion role, runs Gemini 2.5 Flash) operate the POS chat as a guided, multi-turn assistant.

The contest period work ensures **both personas** can orchestrate agents:
- **Owner** invokes Supervisor via chat + A2A for advanced business logic (rules, forecasting, fiscal compliance).
- **Employee** invokes Companion via chat with permission-gated escalations to Supervisor.
- **Payments Agent** and **Fiscal Agent** operate autonomously over the A2A bus (Velora Supervisor coordinates multi-agent flows).

### Cloud-Native Runtime
Entire backend runs on **Google Cloud Run** (`southamerica-east1`):
- Next.js App Router route handlers deployed as Cloud Run services.
- **Agent Engine** (Vertex AI ADK runner) executes Python agents for asynchronous workflows (inventory planning, reconciliation, fiscal compliance).
- All observability via **Cloud Logging** (replaced console.warn during contest period).
- Migrations applied manually against Supabase Postgres via `npx prisma db execute` (see CLAUDE.md — migration workflow).

### Vertex-Powered Intelligence
- **100% Google Cloud AI**: Gemini 2.5 Pro (Supervisor) + Gemini 2.5 Flash (Companion).
- All AI inference via `@google-cloud/vertexai` (Model Garden: Supervisor/Pro → `us-south1`; Companion/Flash → `southamerica-east1`; Flash-Lite classifier → `us-central1`).
- **ADK integration**: Python agent code at `agent-engine/` uses Google's `google-adk` package for tool-calling, structured output, and agent composition.
- **Removed Anthropic entirely** (Haiku was removed April 2026; do not reintroduce per project standards).

### A2A Interoperability
- **Supervisor + 3 active translator agents** communicate over the **A2A (Agent-to-Agent) bus**:
  1. **Supervisor** (Owner-facing, Gemini Pro, ADK InMemoryRunner): Orchestrates all translator agents via three active role-agent FunctionTools, validates rule policies, escalates employee requests.
  2. **Payments Translator Agent**: Processes QR payments, validates MercadoPago transactions; wraps MercadoPago API.
  3. **Fiscal Translator Agent**: ARCA-compliant invoice generation, tax calculations, compliance audits; wraps ARCA WSAA + WSFE SOAP (sandbox mode pending credentials).
  4. **MercadoLibre Translator Agent** (built during contest period): Bridges offline Velora store with ML marketplace — catalog sync, order receive, stock update, pricing sync; wraps MercadoLibre API.
  5. **Andreani Translator Agent** (built during contest period): Logistics — shipment quote, create, and track; wraps Andreani REST API (mock mode pending credentials).

- **A2A v0.3.0** (AgentCard exposure): Each agent exposes a `.well-known/agent-card.json` endpoint for discovery, capability advertisement, and secure key exchange.
- **Cryptographic Agent Identity**: Ed25519 JWKS-based signing on all A2A payloads; HMAC-bound tenant keys prevent cross-tenant message leakage.
- **Domain-event reliability**: Unidirectional event streams (S1/S2/S3/R1/R2/R3/R4) with Zod-backed S3 ingestion, atomic upsert on R2, OIDC enforcement on dead-letter routes.
- **Role-Agent Layer (ADK FunctionTools)**: The Supervisor runs as an ADK `Agent` inside an `InMemoryRunner`. Three active FunctionTools sit between the orchestrator and the translator agents — `call_contador_agent` (→ Fiscal/ARCA), `call_ventas_agent` (→ Payments/MercadoPago), `call_logistica_agent` (→ Andreani), `call_marketplace_agent` (→ MercadoLibre — encajonado, not active). When Gemini 2.5 Pro decides to delegate, it invokes one of these tools in-band; each tool issues a real A2A HTTP JSON-RPC call to the target translator. The `usedAdkDelegation` flag tracks whether any delegation fired in a given turn.

---

## Files Created During Contest Period

### ADK & Agent Engine Integration
- **`agent-engine/`** — Python agent framework integration
  - `agent-engine/agents/supervisor.py` — Gemini Pro supervisor with tool-calling
  - `agent-engine/agents/payments-agent.py` — QR payment handler
  - `agent-engine/agents/fiscal-agent.py` — ARCA invoice compliance
  - `agent-engine/runners/adkrunner.py` — ADK task runner
  - `agent-engine/types.py` — Agent I/O schemas

### A2A Protocol & Agent Communication
- **`src/app/api/a2a/`** — Agent-to-Agent bus routes
  - `src/app/api/a2a/agents/[agentId]/route.ts` — Agent card discovery + message ingestion
  - `src/app/api/a2a/_lib/agent-card-builder.ts` — Card schema generation (v0.3.0)
  - `src/app/api/a2a/_lib/transport.ts` — Pub/Sub message handler
  - `src/app/api/a2a/_lib/domain-events.ts` — Event format + reliability protocol
  - `src/app/api/a2a/_lib/verifyA2AApiKey.ts` — Tenant key validation (HMAC)

### Payment Intent & Cobro QR Infrastructure
- **`src/app/api/payment-intents/`** — Core QR checkout flow
  - `src/app/api/payment-intents/create/route.ts` — Payment intent factory
  - `src/app/api/payment-intents/confirm/route.ts` — QR confirmation handler
  - `src/app/api/payment-intents/refund/route.ts` — Refund logic
  - `src/app/api/payment-intents/status/route.ts` — Status polling endpoint
  - `src/app/api/payment-intents/_lib/payment-intent-use-case.ts` — Use-case layer

### MercadoPago Integration
- **`src/app/api/integrations/mp/`** — MercadoPago OAuth + QR routes
  - `src/app/api/integrations/mp/connect/route.ts` — OAuth handshake
  - `src/app/api/integrations/mp/callback/route.ts` — Token exchange
  - `src/app/api/integrations/mp/disconnect/route.ts` — Revocation
  - `src/app/api/integrations/mp/webhook/route.ts` — Transaction notifications
  - `src/app/api/integrations/mp/_lib/mp-qr.ts` — QR generation via MP API
  - `src/app/api/integrations/mp/_lib/mp-routing.ts` — Intent → QR path selection
  - `src/app/api/integrations/mp/_lib/mp-fetch.ts` — HTTP wrapper with exponential backoff
  - `src/app/api/integrations/mp/_lib/webhook-security.ts` — HMAC validation

### Andreani Translator Agent (built during contest period)
- **`src/app/api/agents/andreani/`** — Full A2A translator agent for Andreani logistics
  - `agent-card/route.ts` — A2A AgentCard discovery (A2A v0.3.0, public)
  - `jsonrpc/route.ts` — JSON-RPC 2.0 handler (`message/send` with skill routing)
  - `jwks/route.ts` — Ed25519 public key
  - `webhook/route.ts` — Andreani delivery status push
  - `_lib/handle-andreani-rpc.ts` — JSON-RPC dispatcher (skill router)
  - `_lib/andreani-api-client.ts` — Andreani REST wrapper
  - `_lib/andreani-mock.ts` — mock mode for demo without Andreani credentials
  - `_lib/shipment-quote.ts` — skill: shipment.quote
  - `_lib/shipment-create.ts` — skill: shipment.create
  - `_lib/shipment-track.ts` — skill: shipment.track
  - `_lib/types.ts` — Andreani input/output types

### Role-Agent Layer (ADK FunctionTools)
- **`src/lib/adk/tools/call-contador-agent-tool.ts`** — Routes to Fiscal/ARCA translator
- **`src/lib/adk/tools/call-ventas-agent-tool.ts`** — Routes to Payments/MercadoPago translator; includes best-effort WhatsApp send when checkout URL is present
- **`src/lib/adk/tools/call-logistica-agent-tool.ts`** — Routes to Andreani translator
- **`src/lib/adk/tools/call-marketplace-agent-tool.ts`** — Routes to MercadoLibre translator (removed from this branch — encajonado, not active)

### MercadoLibre Agent (built during contest period) — (ENCAJONADO — this directory is not present on the submission branch; paths below describe the built-but-not-deployed ML agent)
- **`src/app/api/agents/mercadolibre/`** — Full A2A agent for ML marketplace
  - `agent-card/route.ts` — A2A AgentCard discovery (public)
  - `jsonrpc/route.ts` — JSON-RPC 2.0 handler
  - `jwks/route.ts` — Ed25519 public key
  - `webhook/route.ts` — ML order notifications (HMAC validated)
  - `oauth/authorize/route.ts` + `oauth/callback/route.ts` — ML OAuth flow
  - `_lib/handle-ml-rpc.ts` — JSON-RPC dispatcher
  - `_lib/ml-api-client.ts` — ML REST wrapper (auth + 429 backoff)
  - `_lib/ml-oauth.ts` — OAuth token exchange + refresh
  - `_lib/catalog-sync.ts` — skill: catalog.sync
  - `_lib/order-receive.ts` — skill: order.receive
  - `_lib/stock-update.ts` — skill: stock.update
  - `_lib/pricing-sync.ts` — skill: pricing.sync
  - `_lib/ml-mock.ts` — mock mode for demo without ML credentials
- **`prisma/migrations/*_add_ml_credential`** — MlCredential schema
- **`docs/MERCADOLIBRE_AGENT.md`** — Integration guide

### Rate Limiting & Security Hardening
- **`src/app/api/_lib/rate-limit-core.ts`** — Postgres token bucket backend
- **`src/app/api/_lib/rate-limit-token-bucket.ts`** — Token bucket algorithm
- **`prisma/migrations/20260514000000_add_rate_limit_bucket/migration.sql`** — RateLimitBucket model
- **`tests/unit/rate-limit-token-bucket.test.cjs`** — Token bucket coverage

### Push Notifications (FCM + Web Push Dual-Channel)
- **`src/lib/firebase-admin.ts`** — Firebase Admin SDK wrapper
- **`src/lib/native-push-registration.ts`** — Native push registration for Capacitor
- **`src/app/api/push-notifications/fcm/route.ts`** — FCM subscribe endpoint
- **`src/app/api/push-notifications/unsubscribe/route.ts`** — Unsubscribe handler
- **`src/app/api/push-notifications/_lib/push-resub-prompt.ts`** — Re-subscribe prompts
- **`prisma/migrations/20260513120000_add_fcm_to_push_subscription/migration.sql`** — FCM token storage

### NLU Fast-Path Expansion
- **`src/app/api/business-assistant/_lib/nlu/`** (12+ new intent handlers)
  - `sale-create-fast-path.ts` + `execute-sale-create.ts` — Sale creation shortcut
  - `stock-load-fast-path.ts` + `execute-stock-load-fast-path.ts` — Inventory intake
  - `price-query-fast-path.ts` + `execute-price-query.ts` — Price lookup
  - `delete-product-fast-path.ts` + `execute-delete-product.ts` — Product removal
  - `delete-customer-fast-path.ts` + `execute-delete-customer.ts` — Customer removal
  - `business-setup-fast-path.ts` + `execute-business-setup-fast-path.ts` — Onboarding
  - `sale-mark-paid-fast-path.ts` + `execute-sale-mark-paid.ts` — Payment marking
  - `update-business-rule-fast-path.ts` + `execute-update-business-rule.ts` — Rule updates
  - `execute-stock-query.ts` — Stock summary
  - `execute-invoice-and-purchase.ts` — Invoice/purchase intents

### Onboarding & Employee Task Flow
- **`src/lib/employee-onboarding.renderers.ts`** — Task renderer + seeding
- **`src/app/api/business-assistant/_lib/onboarding-fast-path.ts`** — Onboarding intent detection
- **`src/app/api/business-assistant/_lib/onboarding-fast-path.parsers.ts`** — Input parsing
- **`src/app/api/business-assistant/_lib/onboarding-fast-path.chips.ts`** — Chip rendering
- **`src/app/api/business-assistant/_lib/onboarding-polish.ts`** — Polish seed messages

### Supervisor & Companion Orchestration
- **`src/lib/adk/supervisor-agent.ts`** — ADK `Agent` + `InMemoryRunner` wrapper; `SUPERVISOR_ADK_TIMEOUT_MS` (25s code default / 65s Cloud Run override), `usedAdkDelegation` flag, graceful fallback to direct-Gemini on `TimeoutError`
- **`src/lib/adk/tools/index.ts`** — FunctionTool registry (check-stock, business-query, + 3 active role-agent delegation tools)
- **`src/app/api/business-assistant/_lib/owner-handler.stages.ts`** — Owner intent routing
- **`src/app/api/business-assistant/_lib/employee-handler.stages-b-execute.ts`** — Employee execute stage
- **`src/app/api/business-assistant/_lib/employee-handler.stages-b-post.ts`** — Post-execution
- **`src/app/api/business-assistant/_lib/router-history.ts`** — Message history management
- **`src/app/api/business-assistant/_lib/router-escalation.ts`** — Escalation paths
- **`src/app/api/supervisor/_lib/supervisor-prompt-builder.ts`** — Supervisor LLM prompt

### Business Rules & Policy Engine
- **`src/domain/business-rule/policy-engine.ts`** — Rule evaluation engine
- **`src/domain/business-rule/policy-engine-types.ts`** — Rule type definitions
- **`src/domain/business-rule/policy-engine-evaluators.ts`** — Evaluator implementations
- **`src/app/api/_lib/policy-evaluator.ts`** — Policy evaluation wrapper

### Time-Based Rules (Cron)
- **`src/app/api/scheduled/rule-alerts/_lib/cron-matcher.ts`** — Cron pattern matching
- **`src/app/api/scheduled/rule-alerts/_lib/rule-evaluation.ts`** — Scheduled rule executor
- **`prisma/migrations/20260509200000_add_cron_checkpoint/migration.sql`** — CronCheckpoint model

### Chat UI Components (Cobro QR, Confirmations, etc.)
- **`src/app/dashboard/components/assistant/AssistantCobroQrDraft.tsx`** — QR draft card
- **`src/app/dashboard/components/assistant/AssistantCobroQrDraft.views.tsx`** — QR state views
- **`src/app/dashboard/components/assistant/AssistantCobroQrDraft.confirmed.tsx`** — Confirmed view
- **`src/app/dashboard/components/assistant/AssistantCobroQrDraft.postconfirm.tsx`** — Post-confirm actions
- **`src/app/dashboard/components/assistant/useCobroActions.ts`** — Cobro action handlers
- **`src/app/dashboard/components/assistant/useCobroEnrichedStatus.ts`** — Status enrichment
- **`src/app/dashboard/components/assistant/useCobroScrollIntoView.ts`** — Auto-scroll
- **`src/app/dashboard/components/assistant/useCobroAutoConfirm.ts`** — Auto-confirmation logic
- **`src/app/dashboard/components/assistant/useCobroStatusPoll.ts`** — Polling hook
- **`src/app/dashboard/components/assistant/useCobroRefund.ts`** — Refund handler

### Landing & Role Picker Refactoring
- **`src/app/_landing/mobile-app-landing.tsx`** — Capacitor mobile landing
- **`src/app/_landing/role-picker.tsx`** — Owner/Employee role selection
- **`src/app/landing-motion.css`** — Motion design system
- **`src/app/landing-sections.css`** — Landing section styles
- **`src/app/landing-components.css`** — Component-specific landing CSS

### Native Authentication & Session Management
- **`src/app/_native-bootstrap.tsx`** — Capacitor bootstrap + auth interceptor
- **`src/app/api/auth/native-session/route.ts`** — Native session factory
- **`src/app/api/auth/native-session/refresh/route.ts`** — Token refresh
- **`src/lib/native-fetch-interceptor.ts`** — Request interceptor for native headers
- **`src/lib/owner-native-auth-edge.ts`** — Owner native auth logic
- **`src/lib/google-id-token.ts`** — Google ID token parser
- **`src/lib/cuit.ts`** — CUIT (Argentine tax ID) validator

### Audit & Logs
- **`src/app/api/logs/route.ts`** — Client error logging
- **`src/app/api/admin/audit-log/export/route.ts`** — Audit log export
- **`src/app/api/_lib/supervisor-chat-write.ts`** — Supervisor message audit
- **`src/app/api/scheduled/audit-cleanup/_lib/audit-cleanup.ts`** — TTL cleanup for audit records

### Infrastructure & Crypto
- **`src/infrastructure/crypto/mp-token-cipher.ts`** — MercadoPago token encryption
- **`src/lib/redact-pii.ts`** — PII redaction for shared pools
- **`src/lib/format/money.ts`** — Money formatting utilities
- **`src/lib/handle-sign-out.ts`** — Logout handler

### Testing & Scripts
- **`tests/unit/`** — 50+ new unit tests covering:
  - Fast-path detection (NLU intent matchers)
  - Payment intent use-case
  - Cobro QR handler
  - Rate limiting
  - NLU cobertura regression
  - Employee login accent handling
  - Onboarding polish
  - Business rule evaluation
  - And more

- **`tests/phase4/`** — Integration tests for:
  - Payment intent flows
  - MercadoPago OAuth
  - Confirmation fast-path
  - Adversarial scenarios

- **`scripts/`** (20+ new utility scripts):
  - `smoke-cobro-qr.mjs` — QR smoke test
  - `smoke-orchestrator.mjs` — A2A agent test
  - `smoke-push-e2e.mjs` — Push notification flow
  - `seed-smoke-catalog.mjs` — Catalog seeding
  - `mp-setup-pos.mjs` — MercadoPago POS setup
  - `build-android-apk.mjs` — Capacitor APK builder
  - Database and health check utilities

### Prisma Migrations (12+)
- `20260514000000_add_rate_limit_bucket` — Rate limit bucketing
- `20260513180000_add_cobro_qr_sale_send_onboarding` — Onboarding tasks
- `20260513120000_add_fcm_to_push_subscription` — FCM token support
- `20260512180000_add_employee_id_to_sale` — Sale attribution
- `20260512120000_add_created_by_employee_to_payment_intent` — Payment audit
- `20260511120000_add_matched_customer_id_to_payment_intent` — Customer linking
- `20260511000000_mp_connection_token_ciphertext` — MP token storage
- `20260510220000_persist_employee_onboarding_query_tasks` — Task persistence
- `20260510200000_add_mp_connection` — MercadoPago connection model
- `20260510180000_add_payment_intent_refund` — Refund support
- `20260510160000_add_payment_intent_expires_at` — Expiry tracking
- `20260510140000_add_business_alias` — Business alias
- `20260510120000_add_payment_intent` — Core payment intent model

### Android & Capacitor Integration
- **`android/app/google-services.json`** — FCM configuration
- **`android/app/src/main/res/values-night/styles.xml`** — Dark mode styles
- **`android/app/src/main/res/xml/network_security_config.xml`** — Security policy

### Documentation & Audit Reports
- **`docs/CONTEST_PERIOD_WORK.md`** — This file (contest work delineation)
- **`docs/AUDITORIA_GOOGLE_2026_2026-05-09.md`** — Deep audit (7 operations, payment, rules)
- **`docs/MASTER_AUDIT_PROMPT_GOOGLE_2026.md`** — Reusable audit template
- **`docs/INDEX.md`** — Documentation index
- **`docs/PRD_COBRO_QR_2026-05-10.md`** — QR checkout PRD
- **`docs/PRD_COBRO_QR_MP_REAL_2026-05-11.md`** — Real MercadoPago QR PRD
- **`docs/DEMO_READINESS_2026-05-11.md`** — Demo checklist
- **`docs/DEMO_WIPE_PLAN_2026-05-11.md`** — Data reset procedure
- **`docs/PRE_DEMO_RATE_LIMIT_TOGGLE.md`** — Rate limit runbook
- **`docs/AUDIT_*_*.md`** — 15+ audit reports on specific flows (login, payment, rules, companion, notifications)

### CI/CD & Cloud Build
- **`.github/workflows/post-deploy-smoke.yml`** — Smoke test runner
- **`scripts/cloud-build-alert-function/index.mjs`** — Build failure alerts via Twilio
- **`scripts/check-architectural-invariants.mjs`** — Invariant checker (fast-path baselines)
- **`.gcloudignore`** — Cloud Build ignore file

---

## Files Modified During Contest Period

**Total modified files**: ~829 across:

### Core Chat Pipeline & Routing
- `src/app/api/business-assistant/_lib/router.ts` — Added A2A escalation paths
- `src/app/api/business-assistant/_lib/intent-permissions.ts` — Enhanced RBAC rules
- `src/app/api/business-assistant/_lib/nlu/index.ts` — Fast-path registry expansion
- `src/app/middleware.ts` — Added A2A allowlist + security headers

### NLU Fast-Path Enhancements
- Multiple `*-fast-path.ts` files in `src/app/api/business-assistant/_lib/nlu/`
  - Expanded product vocabulary (AR slang normalization: "comprar/compré", "está/esta", monetario slang)
  - Added confirmation card gating
  - Added pending customer picker chips

### Supervisor & Companion Logic
- `src/app/api/supervisor/route.ts` — Enhanced with A2A federation
- `src/app/api/business-assistant/_lib/companion.ts` — Permission request rework
- `src/app/dashboard/lib/hooks/useAssistantChat.ts` — Multi-agent support

### Authentication & Session
- `src/app/api/auth/[...nextauth]/route.ts` — Native auth fallback + email verification
- `src/lib/session.ts` — Device binding + sliding refresh
- `src/app/api/resolveActor.ts` — Tenant isolation checks

### Database & ORM
- `prisma/schema.prisma` — 13 new models (PaymentIntent, RateLimitBucket, MpConnection, etc.)
- `src/lib/prisma.ts` — Connection pooling + timeout config

### UI Components & Styling
- `src/app/dashboard/components/assistant/` — Cobro QR card components
- `src/app/dashboard/components/TeamSuccessBanner.tsx` — Celebration moment
- `src/app/dashboard/components/BusinessRulesCard.tsx` — Rule UI
- `src/app/dashboard/components/SettingsMercadoPagoCard.tsx` — MP connection UI
- `src/app/dashboard/components/ErrorBanner.tsx` — Canonicalized error display
- `src/app/dashboard/components/ChipButtons.tsx` — Chip button refactor
- Extensive CSS updates for motion, spacing, typography

### Build & Configuration
- `next.config.ts` — Capacitor native bundle exclusions
- `tsconfig.json` — Excluded `ai-engineer-workshop-2026-project` from typecheck
- `package.json` — Added ADK, Vertex AI, Firebase Admin, Capacitor dependencies
- `.env.example` — New secrets (MP_CLIENT_ID, FIREBASE_PROJECT_ID, etc.)

### Tests & Validation
- `tests/unit/run-all.cjs` — Added 20+ test files
- `tests/phase4/run-all.cjs` — Added 5+ integration test suites

### Scripts & Utilities
- `scripts/smoke-matrix-owner-v2.mjs` — Owner smoke flow
- `scripts/check-server-mutation-contract.mjs` — Contract validation
- Multiple utility scripts for debugging, seeding, and deployment

---

## Commits by Theme

### Theme 1: ADK Integration & Agent Engine
(77 commits)

Key commits:
- `c38e9b8d` — feat(a2a): well-known discovery for all 3 agents (Supervisor, Payments, Fiscal)
- `84e8050a` — fix(build): inline CUIT utils + externalize @google/adk to fix Next.js bundle errors
- `7b5302e2` — perf(vertex): split Flash/Pro regions to shortest path from southamerica-east1
- `823da40e` — fix(a2a): log fiscal route errors and ADK runner failures via cloudLog
- `5c5a8e52` — fix(adk): zod cast for FunctionTool nominal compat
- `b3464fef` — fix(adk): use isFinalResponse to prevent tool-call error events from overwriting final response text
- `765e701b` — feat(a2a): complete agent card (initial v0.2.0 → upgraded to v0.3.0) + multi-turn session store
- `b852efd4` — feat(a2a): STOCK_INGRESS_REQUEST walkie-talkie flow — employee reports stock via A2A
- `0cbe0d3e` — feat(a2a-bus): filter to agent-only events; update copy to Bus A2A
- `7dc8ffed` — fix(a2a): hardcode agent card baseUrl to canonical somosvelora.com

### Theme 2: A2A Protocol & Cryptographic Identity
(47 commits)

Key commits:
- `27858c1a` — fix(a2a): require OIDC on dead-letter endpoint to stop log poisoning
- `9e9de968` — refactor(a2a): consolidate fiscal+payments auth into shared verifyA2AApiKey helper
- `eb8fa638` — fix(a2a): echo request contextId in reply to preserve multi-turn thread per spec
- `29689b08` — feat(a2a): 4 fixes — escalation phrases, supervisor alerts context, onboarding transition push, ack persistence
- `e9faa4f7` — feat(a2a): escalation push + onboarding CTA chip
- `d374edd8` — fix(a2a): domain events reliability — R4 format unification, S3 Zod parser, R1 retry cron, S1 OIDC enforcement, R2 atomic upsert, S2 businessId cross-check
- `c3b49ae1` — fix(a2a): HMAC-bound per-tenant keys; kill global A2A_API_KEY; A2A_SECRET derives all tenant keys
- `7dc8ffed` — fix(a2a): hardcode agent card baseUrl to canonical somosvelora.com

### Theme 3: Payment Intent & Cobro QR
(408 commits)

Key commits:
- `a33b2129` — feat(payment-intent): core payment intent model + create/confirm/refund routes
- `e0810087` — feat(cobro-qr): post-confirm actions Mandar comprobante / Listo on confirmed card
- `44bbf883` — feat(payment-intents): expose invoiceId + customerHasPhone in status response
- `1ced213d` — feat(cobro-qr): auto-scroll to QR card when generated for visibility
- `578f88b5` — feat(sale): pre-LLM payment method chips when user omits payment in sale intent
- `4d60c664` — feat(onboarding): add cobro_qr and sale_send tasks to employee onboarding
- `c18c397b` — fix(cobro-qr): allow expired→confirmed transition + eager poll on mount
- `b8627e29` — feat(mp): exponential backoff on MP API 429 responses
- `c81a434c` — fix(mp-qr): add explicit currency_id=ARS to QR PUT body
- `d478d078` — feat(payment-intent): refund support + mutation contract

### Theme 4: MercadoPago Integration
(128 commits)

Key commits:
- `de0f7b8e` — feat(mp): OAuth flow + token storage + refresh
- `29ceeb5f` — feat(mp): real QR handler + webhook ingestion
- `39f189f4` — feat(mp): payment-intent-post-confirm linking + matched customer ID
- `3e69cf78` — feat(mp): webhook security (HMAC validation)
- `317376df` — feat(mp): webhook-push for async transaction notifications
- `5abf8a31` — feat(mp): token encryption via mp-token-cipher
- `f382a001` — feat(mp): business alias for QR + alias-based lookups
- `d478d078` — feat(payment-intent): refund transaction logic
- `87a039c6` — feat(sound): play-confirm beep on QR confirmation

### Theme 5: Rate Limiting & Security Hardening
(59 commits)

Key commits:
- `185a7f4d` — feat(rate-limit): Postgres token bucket backend with feature flag RATE_LIMIT_USE_DB
- `b2744c35` — feat(db): add RateLimitBucket model and migration for distributed rate limiting
- `2fb3e595` — fix(security): harden client-error endpoint and migrate console.warn to cloudLog
- `b3e8e670` — fix(security): cap unbounded Prisma findMany queries — DoS protection
- `104d2841` — fix(security): add LLM timeout gate and payload size caps on chat endpoints
- `e5cf0c26` — fix(rate-limit): scope expensive and upload endpoints to tighter limits
- `9b6ae700` — fix(rate-limit): raise AI limits to production values for 100-business scale
- `2831f33c` — fix(tenant-isolation): add inline SEC-NOTE comments on public/employee routes
- `acba9649` — fix(security): redact PII before persisting to shared PromptExample pool
- `5ed1b9e4` — fix(security): CSP connect-src Capacitor + no-store API + Permissions-Policy camera + DNS prefetch off
- `fb522d9c` — fix(security): cerrar timing leak de email enumeration en employee login con dummy hash
- `5aac7370` — fix(security): use last XFF IP in employee login to match middleware

### Theme 6: Push Notifications (FCM + Web Push Dual-Channel)
(62 commits)

Key commits:
- `ed0c6f60` — feat(push): firebase-admin wrapper + native push registration + FCM subscribe endpoint
- `ba6dc82e` — feat(db): add kind + fcmToken fields to PushSubscription for dual-channel push
- `2c4ff567` — chore(deps): add @capacitor/push-notifications and firebase-admin
- `7a19d3d9` — feat(push): client-side FCM registration on native platform — dual-channel owner + employee
- `ded8421e` — feat(push): dual-channel fan-out — route FCM vs Web Push by subscription kind
- `ad781b08` — feat(push): prompt user to re-subscribe after expiry
- `7a56d4e5` — feat(cron): cleanup-payment-intents route (removes expired intents)
- `f58d4fa0` — feat(push): subscribeOwnerPush hook for sidebar banner

### Theme 7: NLU Fast-Path Expansion (6 Fixes + 20+ Intents)
(140 commits)

Key commits:
- `feecec52` — feat(nlu): intent sale_create_pending_customer — picker chips cuando falta cliente
- `10d03339` — fix(nlu): delete_product acepta bare noun cuando match exacto en catálogo
- `87959f83` — fix(nlu): normalizar slang monetario AR + variantes verbales de cobro
- `7937aeee` — fix(nlu): agregar comprar/compré a verbos de stock load
- `ed89e9bd` — fix(nlu): agregar 'está/esta' a price query — cubre patrón AR canónico
- `c0ffae84` — fix(nlu): stock summary no roba frases con nombre de producto antes de stock
- `dd7adebe` — test(nlu): cobertura de regresión para los 6 fixes del Fast Path
- `786a33d4` — feat(invariants): architectural baselines for fast-path count tracking

### Theme 8: Supervisor & Companion Orchestration
(128 commits)

Key commits:
- `80ffd443` — refactor(chat): pipeline-registry + owner-handler.stages + context management
- `9e8c83ea` — feat(escalation): router-escalation for B1/B2 triggers
- `646f78cd` — feat(history): router-history for multi-turn context
- `fa140e07` — feat(companion): execute stage + post-execution stage split
- `ef0e3a16` — feat(supervisor): supervisor-prompt-builder with business context
- `be0c37bf` — fix(companion): first_sales_query only triggers on sales-summary regex, not any business_query
- `67ba1aae` — fix(companion): simplify welcome message to greeting + single concrete instruction
- `7d980d25` — fix(companion): isPermissionRequest requires explicit authorization marker, not just keywords
- `0415093b` — fix(companion): permission bounce always includes concrete action for employee
- `71f42d21` — fix(companion): render business context as readable block instead of JSON-in-history

### Theme 9: Business Rules & Policy Engine
(82 commits)

Key commits:
- `27cead56` — feat(rules): policy-engine.ts + type system + evaluator implementations
- `09d928230` — feat(policies): policy-evaluator wrapper for mutation contract
- `3ba1caa0` — feat(rules): rule-evaluation for scheduled triggers (cron-matcher)
- `774da69c` — feat(db): CronCheckpoint model for catch-up window tracking
- `f5ca0780` — fix(supervisor): raise active-rules cap to 20, order by createdAt desc, warn at threshold
- `ce62a9ff` — fix(rules): warn and block submit when condition-based pattern detected in form

### Theme 10: Employee Onboarding & Task Flow
(86 commits)

Key commits:
- `4d60c664` — feat(onboarding): add cobro_qr and sale_send tasks to employee onboarding
- `ef05d390` — feat(onboarding): fast-path chips + parsers + confirmation response
- `01865b9c` — feat(onboarding): polish seed message + test coverage
- `f498f51c` — feat(db): persist employee onboarding query tasks
- `344030de` — feat(onboarding): T6 step to connect MercadoPago after first product
- `ea305db7` — fix(onboarding): seed message removes internal 'supervisor' label, Velora brand identity in employee answers

### Theme 11: Native Authentication & Capacitor Integration
(94 commits)

Key commits:
- `2aaf6d50` — feat(native): bootstrap interceptor + native session factory + native fetch interceptor
- `91e0d67` — feat(native): google-id-token parser for native OAuth
- `626ab39` — feat(push): smoke-push-e2e for push flow validation
- `d1f8134c` — feat(android): add google-services.json + capacitor sync for FCM native push
- `5029a076` — fix(android): declare CAMERA and POST_NOTIFICATIONS permissions
- `ad93dc57` — feat(fcm): support Application Default Credentials + FIREBASE_PROJECT_ID
- `ace1c44e` — feat(employee-auth): device-binding via localStorage to skip business code on return visits
- `3fd5f4a2` — feat(landing): dedicated mobile-app landing for Capacitor + restore Phosphor role icons

### Theme 12: UX / Chat UI Improvements & Polish
(156 commits)

Key commits:
- `eeae6819` — feat(cobro-qr): cinematic confirmation moment
- `06208873` — fix(chat-ui): polish empty state chips, FAB icon, mic error, cobro CTA
- `06208873` — fix(ui): unify cobro QR confirmation color + countdown pill + invoice copy
- `90c6cef8` — fix(chat-ui): network error retry banner + context-aware empty state chips
- `7542d72c` — fix(chat-ui): replace alert() with inline error in cobro QR postconfirm
- `a288564d` — fix(chat-ui): touch targets 44px on customer chips and file preview buttons
- `dd478735` — fix(a11y): confirmation dialog role=alertdialog with aria-modal and focus trap
- `7d5cd150` — fix(a11y): remove duplicate aria-live and role=status from ThinkingIndicator
- `79be1426` — feat(settings): capability hints + completeness indicator
- `00c0a358` — feat(chat): empty state Velora mark bump + breathing animation

### Theme 13: Landing Page & Role Picker
(43 commits)

Key commits:
- `3fd5f4a2` — feat(landing): dedicated mobile-app landing for Capacitor + restore Phosphor role icons
- `685af9fe` — feat(landing): role-picker component (owner vs employee fork)
- `2113fb8d` — feat(landing): landing-motion + landing-sections + landing-components CSS
- `c65904d6` — feat(role-picker): brand moment with velora-mark + Fraunces labels
- `a6089462` — feat(brand): surface "Tu negocio AI" tagline in dashboard sidebar
- `4cf4b1aa` — feat(onboarding): velora-mark thinking indicator in onboarding chat
- `a18633c7` — feat(loading): repair broken shimmer gradient + consolidate pattern
- `4d44b60f` — feat(empty-state): Fraunces title for editorial weight

### Theme 14: Infrastructure, Migrations & Deployment
(128 commits)

Key commits:
- `0ffd3eaf` — feat(scripts): atomic db:reset for safe wipes pre-demo
- `b35cf4db` — docs(infra): setup guide for Cloud Build failure alerts via Twilio
- `89fa490d` — feat(health): include auth providers check in /api/health
- `.github/workflows/post-deploy-smoke.yml` — Smoke test runner integration
- `6b1152c3` — feat(workflow): post-deploy-smoke CI for production validation
- Multiple Prisma migrations (see Files Created section)

### Theme 15: Testing & Validation Coverage
(91 commits)

Key commits:
- `dd7adebe` — test(nlu): cobertura de regresión para los 6 fixes del Fast Path
- `652ee0a0` — tests(unit): cobro-qr-handler coverage
- `c90966bc` — tests(unit): landing-bfcache-guard
- `8aaa3a10` — tests(unit): cross-role-scenarios + execute-sale-send-guard
- `9af995233` — tests(unit): smoke-adversarial scenarios
- `dc017db9` — tests(unit): adk-employee-fallback + execute-price-query
- Multiple phase4 integration test suites (payment-intent-flow, mp-oauth-flow, confirmation-fast-path)

### Theme 16: Documentation & Audit Reports
(27 commits)

Key commits:
- `c20f3ecf` — docs: AUDITORIA_GOOGLE_2026_2026-05-09.md + MASTER_AUDIT_PROMPT_GOOGLE_2026.md
- `f5f566ea` — docs: INDEX.md + PRD_COBRO_QR_2026-05-10.md + archive folder
- `56723f64` — docs: AUDIT_CUJ_2026-05-12.md
- `c540520865` — docs: 16 detailed audit reports (login, payment, companion, rules, notifications, etc.)
- `182cf5be` — docs: DEMO_READINESS_2026-05-11.md + DEMO_WIPE_PLAN_2026-05-11.md
- `107c318ce` — docs: POSTMORTEM_BEARER_AUTH_2026-05-11.md
- `61980aa93` — docs: AUDIT_LOGIN_APP_2026_2026-05-11.md
- `81e3779274` — docs: AUDIT_MP_2026_2026-05-11.md
- `d3bdc59b8` — docs: AUDIT_LOGIN_GOOGLE_2026_2026-05-11.md

---

## Architectural Decisions & Track 3 Alignment

### Multi-Agent Orchestration (Supervisor → Role-Agent Layer → Translator Agents)
- **Owner** (Supervisor, Gemini Pro 2.5, ADK InMemoryRunner): Orchestrates payment + fiscal + logistics + marketplace workflows via the role-agent FunctionTool layer.
- **Employee** (Companion, Gemini Flash 2.5): Operates daily POS tasks with permission-gated escalations.
- **Payments Translator Agent**: QR checkout + MercadoPago reconciliation; wraps MercadoPago API.
- **Fiscal Translator Agent**: ARCA-compliant invoice generation (sandbox mode; WSAA + WSFE real endpoint pending per-client credentials).
- **Andreani Translator Agent**: Shipment quote, create, and track; mock mode pending per-client Andreani credentials.
- **MercadoLibre Translator Agent**: Catalog sync, order receive, stock and pricing update; wraps MercadoLibre API.

The two-layer design (role-agents over translator-agents) keeps orchestration concerns (business intent resolution, multi-step coordination) cleanly separated from transport concerns (API auth, retry, mock fallback). The role-agent tools set `usedAdkDelegation = true` in the Supervisor result when any delegation fires, enabling observability into ADK vs. direct-Gemini path usage.

### ADK & Vertex AI Integration
- Python agents at `agent-engine/` use `google-adk` package (`requirements.txt`).
- All LLM inference routed through `@google-cloud/vertexai` to Model Garden (Gemini 2.5 Pro/Flash).
- Regions optimized for latency (Supervisor/Pro → `us-south1`; Companion/Flash → `southamerica-east1`; Flash-Lite classifier → `us-central1`).

### A2A Protocol (v0.3.0)
- Agent Card v0.3.0 with `.well-known/agent-card.json` discovery.
- Ed25519 JWKS for agent identity.
- HMAC-bound tenant keys prevent cross-tenant message leakage.
- Domain-event unidirectional streams (S1/S2/S3/R1/R2/R3/R4) with Zod validation.

### Rate Limiting (Distributed Token Bucket)
- Postgres backend (feature-flagged `RATE_LIMIT_USE_DB`).
- Per-endpoint budgets (expensive operations capped tighter).
- Production scale: 100+ businesses per Cloud Run replica.

### Push Notifications (Dual-Channel)
- Native FCM for Capacitor Android.
- Web Push for browser-based owners.
- Automatic re-subscription prompts on token expiry.

### Security Hardening
- PII redaction before shared PromptExample pool.
- CSP + Permissions-Policy enforcement (Camera, Notifications).
- LLM timeout gates + payload size caps.
- Tenant isolation enforcement on public routes.

---

## Verification

To independently verify the contest period work:

```bash
git log --since="2026-04-22" --until="2026-06-05" --pretty=format:'%h %ad %s' --date=short
```

All commits in this range are part of the contest submission.

**Note**: Some commits are merge commits from parallel agent worktrees (coordinated development). The substantive work is visible in commits without "Merge branch" messages.

---

## Submission Compliance

The following documents form the complete Track 3 submission package:

| Document | Path | Description |
|----------|------|-------------|
| Contest Period Work | `docs/CONTEST_PERIOD_WORK.md` (this file) | Delineation of work authored during contest period, per Option A approval from a Google contact (Google, 2026-04-29) |
| Architecture Diagram | [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md) | Mermaid multi-agent architecture diagram, two sequence diagrams (QR payment flow, A2A external discovery), ASCII fallback, tech stack table |
| Submission Description | [`docs/SUBMISSION_DESCRIPTION.md`](./SUBMISSION_DESCRIPTION.md) | Full English-language project description for judges — problem, solution, agent breakdown, Track 3 mandate compliance evidence, technologies, findings |
| Demo Video Script | [`docs/DEMO_VIDEO_SCRIPT.md`](./DEMO_VIDEO_SCRIPT.md) | 7-frame storyboard + voiceover script (es-AR + English subtitles), production notes, timing breakdown for 90–120s video |
| Demo Video | `./demo-video.mp4` | To be recorded (see `DEMO_VIDEO_SCRIPT.md`) |

**Repository**: github.com/crossi-dev/velora (public during judging period)  
**Live demo**: somosvelora.com · demo access: owner@example.com  
**Submission email**: Per a Google contact Option A — submit repo URL + this document set

---

## Next Steps (Post-Contest)

- **Fiscal Agent implementation** (ARCA invoice generation, tax compliance) — deferred post-demo.
- **DB hosting** — currently on Supabase Postgres (migrated from Neon 2026-05-23). Cloud SQL evaluated and declined (cost/scale-to-zero). Re-evaluate at scale if needed.
- **Row-Level Security (RLS)** — add DB-layer tenant isolation (currently app-level only).
- **TTL automation** — extend `AuditLog` and movement-table retention policies.
- **Advanced reporting** — Owner analytics dashboard (inventory velocity, payment trends, rule performance).

---

**Last updated**: 2026-05-14 (commit count updated: 1,422 commits as of today; Submission Compliance section added)  
**Status**: Submission package complete — ARCHITECTURE.md, SUBMISSION_DESCRIPTION.md, DEMO_VIDEO_SCRIPT.md created. Video recording pending.
