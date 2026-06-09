# Velora — A2A Interoperability Layer for Multi-Agent Enterprise Coordination (LATAM)

## Track 3: Refactor for Google Cloud Marketplace & Gemini Enterprise

---

### Summary

Velora is a chat-first, multi-agent AI system that acts as the interoperability layer between a company and the counterparties it depends on. A company — a distributor above all — runs on constant coordination: with its downstream points of sale, with logistics carriers, with the tax authority, with payment rails, with online marketplaces, with other companies. Today that coordination is human and slow — sales reps, phone calls, emails, shared spreadsheets, a person in every loop. Velora turns it agent-to-agent: a company's Supervisor agent orchestrates a federation of specialist agents — each one a standards-compliant A2A translation of an external system — and discovers and calls external counterparty agents over the open A2A protocol. Owners and employees drive the whole network in plain Argentine Spanish, from any browser or Android phone.

Velora is built 100% on Google Cloud. All AI inference runs through Vertex AI (Gemini 2.5 Pro for the owner-facing Supervisor, Gemini 2.5 Flash for the employee-facing Companion). The agent orchestration layer uses the Google ADK: the Supervisor holds in-band role-agent FunctionTools that delegate to A2A v0.3.0 translator agents (Payments, Fiscal, Andreani), each a standards-compliant wrapper for an external system. The backend runs on Cloud Run in `southamerica-east1`, with Vertex AI Agent Engine deployed as a Python ADK runtime (interactive traffic runs on the Cloud Run TypeScript path). Vertex AI Search is implemented and wired for per-tenant semantic product lookup; it is feature-flagged (`USE_VERTEX_SEARCH`) and currently disabled in production pending datastore provisioning.

The contest period work (April 22 — June 5, 2026) transformed Velora from a single-agent chat system into a production-grade multi-agent interoperability layer. That work includes: a full A2A protocol implementation with cryptographic agent identity (Ed25519 JWKS), Vertex AI Agent Engine deployment (Python ADK), distributed Postgres-backed rate limiting for multi-instance Cloud Run, dual-channel push notifications (FCM + Web Push), comprehensive security hardening (OWASP audit, PII redaction, tenant isolation), and 1,400+ commits of iterative hardening across the entire stack.

---

### Problem

A company in LATAM — and a distributor most of all — lives by coordinating with a web of counterparties: downstream points of sale, logistics carriers (Andreani, Correo Argentino, OCA), the tax authority (ARCA), payment rails (MercadoPago and the bank network), online marketplaces (MercadoLibre), and other distributors upstream and across. None of these systems speak a common language. So coordination runs through people — sales reps walking routes, phone calls, emails, shared spreadsheets — with a human in every single loop.

The result is operational drag that compounds with scale. A sale in one channel does not update inventory in another. A cash payment does not generate an electronic invoice. A shipment handed to a carrier does not reconcile against the order automatically. Every counterparty added — a new carrier, a new sales channel, a second warehouse, a downstream franchise — multiplies the coordination overhead instead of sharing it. People spend hours per week on manual reconciliation, and mistakes happen wherever a human bridges two systems by hand.

No existing tool addresses this as an interoperability problem. Legacy enterprise software is siloed and desktop-bound. Point solutions — a payments app, an inventory tool, a logistics portal — each solve one corner and do not talk to each other. The gap is a layer that lets a company's systems coordinate agent-to-agent: a common protocol, plus a translator for every counterparty system that does not speak it yet.

---

### Business Case

#### The Opportunity

Latin America's retail e-commerce market reached **$191.25 billion in 2025** — the world's fastest-growing retail e-commerce market in 2025, outpacing global growth at 12.2% year-over-year ([eMarketer, 2025](https://www.emarketer.com/content/latin-america-ecommerce-forecast-2025-growth-outlook-argentina-brazil-mexico)). In Argentina alone, e-commerce billing grew 181% in 2024 ([CACE Annual Study 2024](https://cace.org.ar/blogs/news/estudio-anual-de-cace-2024-el-ecommerce-en-argentina-alcanzo-los-22-billones-en-facturacion)). On the B2B side, the LATAM B2B e-commerce market was valued at **$694 billion in 2024**, growing at a 23.9% CAGR through 2033 ([Straits Research](https://straitsresearch.com/report/b2b-ecommerce-market/latam)).

The growth is real. The coordination infrastructure to support it is not. The SMB and distributor segment — the backbone of LATAM retail — still runs on phone calls, WhatsApp threads, and spreadsheets bridging incompatible systems. Every order taken by a sales rep involves a manual chain: check stock, confirm price, collect payment, generate an electronic invoice against ARCA, hand off to a logistics carrier, follow up on delivery. Each step is a potential failure point, and each failure costs staff time or customer trust.

The concrete, validated pain is **employee turnover and training cost**. Frontline retail employees in LATAM turn over at high rates; replacing an employee can cost between one-half and two times their annual salary ([Gallup](https://www.gallup.com/workplace/247391/fixable-problem-costs-businesses-trillion.aspx)). Velora eliminates the training burden for routine operations — recording a sale, checking stock, issuing a payment link, quoting a shipment — because the Companion agent guides the employee through every step in plain language, with no system knowledge required.

#### The End-to-End Agentic Commerce Loop

What differentiates Velora is not any single capability but the **demonstrable end-to-end workflow** — autonomous agents handling the entire commerce cycle without human bridges:

1. A customer messages the business on WhatsApp → the Customer Agent (Gemini 2.5 Flash) resolves the order against the live catalog, collects a delivery address, and quotes shipping via the Andreani Agent over A2A.
2. A payment link is generated via the Payments Agent (MercadoPago OAuth + QR) and sent back to the customer on WhatsApp.
3. On payment confirmation (MercadoPago webhook), the Fiscal Agent generates an electronic invoice using ARCA's WSAA/WSFE SOAP protocol — automatically, without any human touch (the demo runs the ARCA sandbox path; real AFIP emission is flag-gated via `ARCA_REAL_MODE`).
4. The Andreani Agent creates the dispatch order and returns a tracking number (the demo uses Andreani in mock mode, pending per-client carrier credentials).
5. The owner receives a real-time push notification (FCM + Web Push) at each milestone — payment confirmed, invoice issued, shipment dispatched.

This is not a chatbot layered on top of existing tools. It is **agent-to-agent orchestration across three A2A translator agents** (MercadoPago, ARCA, Andreani) — triggered by a customer's WhatsApp message and coordinated by a Supervisor running Gemini 2.5 Pro on Vertex AI, with every step authenticated via Ed25519 JWKS and executed over the open A2A v0.3.0 protocol.

#### Who Pays and Why

The paying customer is the **merchant or distributor** — a business that today employs people specifically to bridge the coordination gaps Velora automates. The value proposition is direct: replace per-step manual labor (and the turnover cost of the people doing it) with an agent layer that scales linearly with transaction volume, not headcount. At the enterprise / distribuidora tier, the same A2A architecture extends to coordinating with downstream points of sale, upstream suppliers, and logistics networks — compounding the value with each counterparty added.

#### Google Cloud Marketplace Distribution

Velora is architected for the Track 3 mandate: packaged as a Google Cloud Marketplace listing, deployed into the customer's own GCP project (Cloud Run + Vertex AI), connected to their counterparty systems via A2A agent-card discovery. No custom integration work per customer — the A2A protocol handles discovery and authentication.

The pricing model is **per-tenant subscription** (monthly, based on transaction volume), surfaced through Google Cloud Marketplace's private offer mechanism. Google's ISV revenue share is 98% on new deals and 98.5% on renewals ([Google Cloud Marketplace Vendor Net Revenue Schedule, effective April 21, 2025](https://docs.cloud.google.com/marketplace/docs/partners/revenue-share-scenarios)), making the Marketplace a commercially viable channel, not just a distribution checkbox. Customers purchasing through the Marketplace can apply spend toward their existing Google Cloud Committed Use commitments — a meaningful procurement incentive for enterprise buyers.

#### Why Now and Why This Moat

The timing is structural: A2A v0.3.0 is the first open, vendor-neutral agent interoperability protocol with real adoption across the major AI platforms. Building on it now means **any agent or ERP that speaks A2A can plug into Velora's network without rework** — a distribuidora running a legacy SAP instance, a logistics carrier exposing a new REST API, a downstream franchise using a different AI platform. The interoperability is the moat, not single-vendor lock-in. And because Velora's translator agents wrap industry-standard external APIs (not proprietary schemas), the same architecture extends to any market where those APIs exist.

---

### Solution

Velora's core insight is that **the coordination itself is the product.** Instead of another silo, Velora is the common language — and the translator for the systems that have no common language of their own.

The system operates on two faces. The **owner track** (Supervisor, Gemini 2.5 Pro) is the orchestrator: it handles business rules, multi-agent orchestration, payment confirmation, fiscal compliance, long-context analysis of operational patterns, and A2A federation with external agents. The **employee track** (Companion, Gemini 2.5 Flash) runs the daily operations loop: recording sales, checking stock, handling customer queries, escalating to the Supervisor when an action exceeds the employee's permission scope.

Behind the Supervisor sits a federation of A2A agents — and the decisive move is that **each specialist agent is a standards-compliant A2A translation of an external system.** The Fiscal Agent wraps ARCA's legacy SOAP interface (WSAA + WSFE) and exposes it as a clean A2A agent. The Payments Agent wraps the MercadoPago API. The Andreani Agent wraps the logistics carrier API. The Supervisor orchestrates them over signed JSON-RPC 2.0, and discovers and calls external counterparty agents via `/.well-known/agent-card.json` lookup. Whatever protocol a counterparty speaks — modern REST, decades-old SOAP, or A2A itself — Velora makes it one orchestratable agent network.

A tiered NLU pipeline ensures <200ms responses on the most common intents. On the **employee path**, a three-tier pipeline applies: Deterministic Fast Path (regex + catalog lookup, no LLM) → Gemini Flash slow path → Supervisor escalation. On the **owner path**, a two-tier pipeline applies: Deterministic Fast Path → Gemini Pro (the Flash middle-tier was removed 2026-05-30). The Fast Path covers >20% of traffic without any LLM call — sale recording, stock queries, price lookups, customer management.

Payment collection shows the pattern end-to-end: an employee says "cobrar con QR", a MercadoPago QR code appears in the chat, the customer scans it, and within seconds the owner receives a push notification confirming the payment, the invoice is recorded, and a WhatsApp receipt is sent to the customer — all without leaving Velora, and every step a coordinated call between the Supervisor and the Payments and Fiscal agents.

---

### Architecture

Velora runs a two-layer multi-agent topology on Google Cloud Run (`southamerica-east1`).

**Layer 1 — Role-Agent FunctionTools (in-band, inside the Supervisor ADK runner):** The Supervisor holds three active ADK `FunctionTool` role-agents that sit between Gemini 2.5 Pro and the external translator agents. When the model decides to delegate, it invokes one of these tools, which issues a real A2A HTTP JSON-RPC call to the matching translator:

| Role-Agent Tool | Routes to | External System |
|---|---|---|
| `call_contador_agent` | Fiscal Translator Agent | ARCA WSAA + WSFE SOAP |
| `call_ventas_agent` | Payments Translator Agent | MercadoPago QR + OAuth |
| `call_logistica_agent` | Andreani Translator Agent | Andreani REST API |

**Layer 2 — Translator Agents (A2A v0.3.0 endpoints):** Three specialist agents, each exposing agent-card discovery, Ed25519 JWKS identity, and a JSON-RPC 2.0 handler. Each is a standards-compliant A2A translation of an external system.

For the full architecture diagram (Mermaid + ASCII), see [docs/ARCHITECTURE.md](./ARCHITECTURE.md).

---

### Multi-Agent System

#### Supervisor Agent (Owner-facing)

- **Model**: Gemini 2.5 Pro via Vertex AI Model Garden
- **Role**: Orchestrates all other agents. Receives owner chat turns, validates business rules (DelegationPolicy, time-based rules, condition-based triggers), dispatches A2A calls to Payments, Fiscal, and Andreani agents via role-agent FunctionTools, and returns structured responses with action chips.
- **Role-Agent FunctionTools**: `call_contador_agent` (fiscal/ARCA), `call_ventas_agent` (payments/MercadoPago), `call_logistica_agent` (logistics/Andreani)
- **Skills**: `business_query`, `rules.evaluate`, `payment.orchestrate`, `fiscal.orchestrate`, `stock.forecast`, `supplier.quote` (external A2A discovery)
- **Runtime**: Cloud Run TS (primary, interactive) + Vertex AI Agent Engine Python ADK (async events via Pub/Sub)
- **Identity**: Ed25519 JWKS at `/api/agents/supervisor/jwks`

#### Companion Agent (Employee-facing, internal module)

- **Model**: Gemini 2.5 Flash via Vertex AI Model Garden
- **Role**: Operations assistant for employees. Guides daily operations (sales, stock, customer lookup) with permission-gated escalations to the Supervisor (B1: employee requests supervisor action; B2: supervisor proactively alerts on anomaly).
- **Skills**: `sale.create`, `stock.query`, `customer.lookup`, `escalation.request`, `onboarding.guide`
- **Design decision**: Internal module within `business-assistant`, not a separate A2A endpoint — avoids a network hop on every cashier turn. Functionally mirrored in Agent Engine via `agent-engine/employee_agent.py`.
- **NLU**: Three-tier pipeline (Deterministic Fast Path → Gemini Flash → Supervisor escalation). Note: the owner path uses a two-tier pipeline (Fast Path → Gemini Pro); the three-tier pipeline applies to the employee path.

#### Payments Agent

- **Role**: QR payment lifecycle — generates MercadoPago QR codes, validates webhook confirmations, links payments to sales and invoices, handles refunds.
- **Skills**: `payment.qr_generate`, `payment.confirm`, `payment.refund`, `payment.status`
- **External**: MercadoPago API (OAuth 2.0, QR in-store, webhook HMAC validation)
- **Identity**: Ed25519 JWKS at `/api/agents/payments/jwks`; JSON-RPC at `/api/agents/payments/jsonrpc`

#### Fiscal Agent

- **Role**: Electronic invoice generation and tax compliance for Argentina (ARCA — WSAA + WSFE SOAP). Emits invoices on sale confirmation, maintains invoice numbering per business, handles ARCA authorization tickets (TAA).
- **Skills**: `fiscal.invoice_emit`, `fiscal.compliance_check`, `fiscal.summary`
- **External**: ARCA WSAA + WSFE SOAP (Argentina AFIP — sandbox today, real endpoint post-demo)
- **Identity**: Ed25519 JWKS at `/api/agents/fiscal/jwks`; JSON-RPC at `/api/agents/fiscal/jsonrpc`

#### Andreani Agent (built during contest period)

- **Role**: Logistics coordinator. Quotes shipment options, creates dispatch orders, and tracks delivery status across Andreani's carrier network. Receives delivery-event webhooks and pushes status updates back to the Supervisor.
- **Skills**: `shipment.quote`, `shipment.create`, `shipment.track`
- **External**: Andreani REST API (mock mode — `ANDREANI_MOCK_MODE=true` pending per-client credentials; full A2A wrapper is the deliverable)
- **Identity**: Ed25519 JWKS at `/api/agents/andreani/jwks`; JSON-RPC at `/api/agents/andreani/jsonrpc`

---

### Track 3 Mandate Compliance

#### B2B Focus

Velora is a business-to-business interoperability layer by construction. Its unit of value is the coordination between a company and its counterparties — not a consumer transaction. The two-role model (Owner = orchestrator, Employee = operator) maps to a company's internal structure; the A2A agent federation is how that company coordinates outward. The Supervisor holds owner-level authority and orchestrates; the Companion holds employee-level authority with explicit escalation paths. The multi-agent system lets a company delegate operational coordination — payment collection, fiscal compliance, marketplace sync, logistics — to specialist agents, each one a translation of a counterparty system, while the owner retains control through the Supervisor.

**Evidence**: `src/lib/rbac-policy.ts`, `src/app/api/business-assistant/_lib/intent-permissions.ts`, `src/domain/business-rule/policy-engine.ts`, A2A DelegationPolicy enforcement at mutation layer.

#### Cloud-Native Runtime

The entire Velora stack runs on Google Cloud:
- **Cloud Run** (`southamerica-east1`): Next.js App Router serving the chat pipeline, all agent endpoints, and API routes.
- **Vertex AI Agent Engine**: Python ADK adapter (`agent-engine/main.py`) registered as a Reasoning Engine for async agent workflows triggered via Pub/Sub.
- **Cloud Scheduler**: 16 jobs managing business rule triggers (every 5 min), audit cleanup, and operational crons — all authenticated via `CRON_SECRET` bearer.
- **Secret Manager**: All credentials (MercadoPago tokens, VAPID keys, A2A secrets, ARCA certificates) stored in Secret Manager, never in environment files committed to source.
- **Cloud Logging**: `cloudLog()` replaces all `console.warn` calls — structured logs with trace context.

**Evidence**: `cloudbuild-dockerfile.yaml`, `Dockerfile`, `docs/AGENT_ENGINE_DEPLOY.md`, `src/lib/cloud-log.ts`.

#### Vertex-Powered Intelligence

- **100% Google AI**: Gemini 2.5 Pro (Supervisor/Owner) + Gemini 2.5 Flash (Companion/Employee). Anthropic was intentionally removed during the contest period; the stack is single-vendor.
- **Vertex AI Agent Engine**: Python ADK agents deployed as a Reasoning Engine (`agent-engine/main.py`) for managed runtime and Pub/Sub async workflows. Interactive traffic runs on the Cloud Run TypeScript path; Agent Engine handles async events.
- **Vertex AI Search**: Implemented and wired for per-tenant product datastore (`velora-products-{businessId}`) — semantic catalog grounding that resolves Argentine regional synonyms. Feature-flagged via `USE_VERTEX_SEARCH`; disabled in the current production deployment, enable via the flag once per-tenant datastores are provisioned.
- **pgvector RAG**: Implemented and wired — Vertex `text-embedding-004` embeddings on Supabase Postgres for semantic recall. Feature-flagged via `USE_EMBEDDINGS`; disabled in the current production deployment, enable via the flag.
- **Long-context analysis**: Gemini 2.5 Pro's 1M+ token context window used for owner analytics — year-of-sales pattern detection, inventory velocity, payment trend analysis.
- **Region routing**: Gemini 2.5 Pro routed to `us-south1` (Model Garden endpoint for Pro — not available in `southamerica-east1`); Flash routed to `southamerica-east1` for lowest latency on cashier turns.

**Evidence**: `src/app/api/business-assistant/_lib/model.ts`, `src/lib/adk/gemini-config.ts`, `src/lib/adk/grounding.ts`, `agent-engine/main.py`.

#### A2A Interoperability

Velora implements A2A v0.3.0 across all agents:

- **Discovery**: Each agent exposes `/.well-known/agent-card.json` (or `/agent-card`) with capability advertisement, skill definitions, authentication requirements, and JWKS URL.
- **Cryptographic identity**: Ed25519 key pairs per agent. Outbound messages signed; inbound messages verified. HMAC-bound per-tenant keys (derived from `A2A_SECRET`) prevent cross-tenant message leakage.
- **Transport**: JSON-RPC 2.0 over HTTPS. The Supervisor calls specialist agents via real HTTP round-trips (`src/lib/a2a-client.ts`), not in-process function calls.
- **Domain events**: Unidirectional event streams (S1/S2/S3 → R1/R2/R3/R4) with Zod-validated ingestion, atomic upsert on R2, OIDC enforcement on dead-letter routes, and 1-hour catch-up window via `CronCheckpoint`.
- **External federation**: The Supervisor can discover and call external counterparty agents via `/.well-known/agent-card.json` lookup — enabling B2B coordination workflows without pre-registration.

**Evidence**: `src/app/api/a2a/`, `src/lib/a2a-client.ts`, `src/app/api/agents/*/agent-card/`, `src/app/api/agents/*/jwks/`, `src/lib/agent-identity.ts` + `src/lib/a2a-card-signer.ts`.

---

### Technologies Used

- **Frontend**: Next.js 16 App Router, React 19, TypeScript (strict), Tailwind v4
- **Mobile**: Capacitor Android (native FCM push, Google Sign-In, offline localStorage queue with idempotency replay)
- **Backend**: Next.js route handlers on Cloud Run (`southamerica-east1`)
- **AI — Owner**: Gemini 2.5 Pro via `@google-cloud/vertexai` (Model Garden, `us-south1`)
- **AI — Employee**: Gemini 2.5 Flash via `@google-cloud/vertexai` (`southamerica-east1`)
- **Agent SDK**: Google ADK (`@google/adk` TS + `google-adk` Python — `requirements.txt`)
- **Agent Runtime**: Vertex AI Agent Engine — Python ADK `AdkApp` registered as Reasoning Engine
- **Semantic Search**: Vertex AI Search (Discovery Engine) — per-tenant product datastores
- **Database**: Supabase Postgres + Prisma v6 (13 models added during contest period; migrated from Neon 2026-05-23)
- **Agent Protocol**: A2A v0.3.0 — JSON-RPC 2.0 over HTTPS, Ed25519 JWKS identity
- **Auth**: NextAuth v5 (Google OAuth — owner) + PIN+cookie session (employee) + device binding
- **Payments**: MercadoPago QR + OAuth 2.0 + Webhooks (HMAC validated) + AES-256 token encryption
- **Marketplace**: MercadoLibre API — catalog, orders, stock, pricing (OAuth 2.0 + webhook HMAC) — code present; not deployed as a live A2A agent on this branch
- **Fiscal**: ARCA WSAA + WSFE SOAP (Argentina electronic invoicing — sandbox; real post-demo)
- **Push**: Firebase Cloud Messaging (native Capacitor) + Web Push VAPID (browser) — dual-channel fan-out
- **WhatsApp**: Meta Cloud API (primary, `WHATSAPP_PROVIDER=meta`) + Twilio sandbox (legacy fallback)
- **Observability**: Cloud Logging (`cloudLog()`), Cloud Run structured logs
- **Scheduling**: Cloud Scheduler (16 jobs) + `CronCheckpoint` model for catch-up
- **Secrets**: Google Secret Manager
- **CI/CD**: Cloud Build (manual trigger on main)
- **Rate Limiting**: Postgres token bucket backend (`RATE_LIMIT_USE_DB`) for multi-instance Cloud Run
- **Testing**: Node.js `--test` runner (50+ unit tests) + Phase 4 integration suites + Playwright e2e

---

### Findings & Learnings

Building a multi-agent interoperability layer in production for LATAM companies surfaced several non-obvious constraints. The most significant is latency tolerance: a frontline employee at a busy counter has roughly 3 seconds of patience before abandoning a chat interaction. This forced a hard architectural decision — the Deterministic Fast Path (regex + catalog lookup, no LLM) must handle the most frequent intents. The tiered NLU pipeline emerged from this constraint, not from a theoretical design: three tiers for the employee path (Deterministic → Flash → Pro escalation); two tiers for the owner path (Deterministic → Pro, after removing the Flash middle tier in 2026-05-30). Every LLM call is a gamble on latency; the Fast Path covers >20% of traffic and reduces p50 latency from ~2s to <200ms on those intents.

The A2A protocol is powerful but adds operational surface area. Cryptographic identity (Ed25519 JWKS) per agent is correct for production but requires careful key rotation, HMAC-bound per-tenant derivation, and dead-letter handling for message replay attacks. We learned that in-process function calls (the initial implementation) mask transport failures that only surface under load — replacing them with real HTTP A2A round-trips revealed several missing error paths and forced better timeout handling throughout the payment flow.

Vertex AI Agent Engine and the Cloud Run TypeScript path are parallel implementations (Python ADK in Agent Engine, TypeScript ADK in Cloud Run). This duplication is intentional — the TS ADK does not yet support `AdkApp.create()` for Agent Engine registration, and Cloud Run TS is the low-latency interactive path. The Python Agent Engine is deployed as a Reasoning Engine and handles async event workflows (Pub/Sub triggers); it satisfies the Track 3 managed-runtime mandate. The `USE_AGENT_ENGINE` flag controls whether query routing passes through Agent Engine; interactive traffic runs on the Cloud Run path regardless. When the TS ADK adds Agent Engine support, the Python path can be retired. This tradeoff — two runtimes for correctness vs. one runtime for simplicity — is the clearest example of a production constraint shaping the architecture during the contest period.

---

### Live Demo

**URL**: [somosvelora.com](https://somosvelora.com)

The landing page is publicly accessible. For full owner and employee demo access (live QR payment flow, multi-agent orchestration), contact: **owner@example.com**

Demo environment uses MercadoPago sandbox credentials. The fiscal agent operates against ARCA sandbox (no real invoices issued during judging).

---

### Code Repository

**URL**: [github.com/crossi-dev/velora](https://github.com/crossi-dev/velora)

The repository will be set to public during the judging period per contest rules.

Contest period work is delineated in [docs/CONTEST_PERIOD_WORK.md](./CONTEST_PERIOD_WORK.md).

---

### Demo Video

**File**: `./demo-video.mp4` (to be recorded — see [docs/DEMO_VIDEO_SCRIPT.md](./DEMO_VIDEO_SCRIPT.md) for the storyboard and script)

**Target duration**: 90–120 seconds  
**Language**: Spanish (Argentine) with English subtitles
