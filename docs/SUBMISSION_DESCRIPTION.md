# Velora — A2A Interoperability Layer for Multi-Agent Enterprise Coordination (LATAM)

## Track 3: Refactor for Google Cloud Marketplace & Gemini Enterprise

---

### Summary

Velora is a chat-first, multi-agent AI system that acts as the interoperability layer between a company and the counterparties it depends on. A company — a distributor above all — runs on constant coordination: with its downstream points of sale, with logistics carriers, with the tax authority, with payment rails, with online marketplaces, with other companies. Today that coordination is human and slow — sales reps, phone calls, emails, shared spreadsheets, a person in every loop. Velora turns it agent-to-agent: a company's Supervisor agent orchestrates a federation of specialist agents — each one a standards-compliant A2A translation of an external system — and discovers and calls external counterparty agents over the open A2A protocol. The owner directs the entire operation from one chat; end customers shop, pay, and receive invoices over WhatsApp — zero humans in the loop.

Velora's AI and agent infrastructure is built on Google Cloud. All AI inference runs through Vertex AI (Gemini 2.5 Pro for the owner-facing Supervisor, Gemini 2.5 Flash for the Customer Agent and Companion). The agent orchestration layer uses the Google ADK across two runtimes: (1) a Cloud Run TypeScript ADK path where the Supervisor holds eight A2A FunctionTools delegating to specialist sub-agents (Payments, Fiscal, Logística, Ventas, Caja, Inventario, Communications, Customer Agent), and (2) a Vertex AI Agent Engine Python ADK runtime that connects to Velora's live MCP server via `ADK MCPToolset + StreamableHTTPConnectionParams`, executing real commerce operations (catalog lookup, sale registration, payment link creation, invoice emission) through the same live MCP server (loading a 5-tool commerce-demo subset — query_catalog, register_sale, create_tracked_payment_link, emit_invoice, connection_status — out of the full 51-tool surface) — verified to return live data. Vertex AI Search Discovery Engine datastores are provisioned per tenant and live in production (USE_VERTEX_SEARCH=true): semantic queries like "bolso para la espalda" resolve to the correct product.

The contest period work (Contest Period: April 22 – June 5, 2026; submission deadline extended to June 11, 2026 per organizer email) transformed Velora from a single-agent chat system into a production-grade multi-agent interoperability layer. That work includes: a full A2A protocol implementation with cryptographic agent identity (Ed25519 JWKS), Vertex AI Agent Engine deployment (Python ADK) executing real commerce via MCP, live Vertex AI Search grounding, distributed Postgres-backed rate limiting for multi-instance Cloud Run, dual-channel push notifications (FCM + Web Push), comprehensive security hardening (OWASP audit, PII redaction, tenant isolation), and 3,180+ non-merge commits of iterative hardening across the entire stack.

---

### Problem

A company in LATAM — and a distributor most of all — lives by coordinating with a web of counterparties: downstream points of sale, logistics carriers (Andreani, Correo Argentino, OCA), the tax authority (ARCA), payment rails (MercadoPago and the bank network), online marketplaces (MercadoLibre), and other distributors upstream and across. None of these systems speak a common language. So coordination runs through people — sales reps walking routes, phone calls, emails, shared spreadsheets — with a human in every single loop.

The result is operational drag that compounds with scale. A sale in one channel does not update inventory in another. A cash payment does not generate an electronic invoice. A shipment handed to a carrier does not reconcile against the order automatically. Every counterparty added — a new carrier, a new sales channel, a second warehouse, a downstream franchise — multiplies the coordination overhead instead of sharing it. People spend hours per week on manual reconciliation, and mistakes happen wherever a human bridges two systems by hand.

No existing tool addresses this as an interoperability problem. Legacy enterprise software is siloed and desktop-bound. Point solutions — a payments app, an inventory tool, a logistics portal — each solve one corner and do not talk to each other. The gap is a layer that lets a company's systems coordinate agent-to-agent: a common protocol, plus a translator for every counterparty system that does not speak it yet.

---

### Business Case

#### Market Size (TAM → SAM → SOM)

| Tier | Value | Basis |
|------|-------|-------|
| **TAM** | $694B | LATAM B2B e-commerce market (Straits Research 2024, 23.9% CAGR) |
| **SAM** | ~$240M–490M ARR addressable | ~515,000 Argentine SMB retail + wholesale × $39–79/mo (from ~525,538 total companies, 98% SMEs — UCEMA Sep 2025) |
| **SOM Y1** | ~$47,400 ARR | Mendoza pilot: 50 PyMEs/franchises × $79 avg/mo (Negocio plan) |

**ROI for the buyer** — a PyME or franchise with a dedicated customer-service/sales function:

Today that function is salaried headcount: order-taking on WhatsApp and phone, payment chasing, manual sales entry, invoicing. An Argentine retail/admin employee at the CCT (Convenio Colectivo de Trabajo) full-time rate costs roughly **ARS 1,100,000–1,400,000/month gross** (≈ **USD 900–1,100/month** at the June 2026 official exchange rate of ~ARS 1,250/USD — [Ministerio de Trabajo CCT rates, 2025](https://www.argentina.gob.ar/trabajo/relacioneslaborales/convenios)). Velora's Customer Agent absorbs the majority of that function — customer qualification, WhatsApp order-taking, payment link dispatch, invoice emission — at a fraction of the headcount cost.

| Item | Before (manual) | With Velora |
|------|----------------|-------------|
| Dedicated customer-service / sales staff | 1 FTE at USD 900–1,100/mo | Oversight only (fraction of 1 FTE) |
| Manual WhatsApp order-taking, payment chasing | 15–25 h/week (model estimate) | <2 h/week |
| SaaS cost | — | USD 79–149/mo (Negocio or Multi-sucursal plan) |
| Net monthly saving per location | — | **USD 700–900** |
| Payback period | — | **<3 days** |
| Franchise math (5 locations) | 5 FTE × USD 1,000 = USD 5,000/mo | USD 149/mo — **97% cost reduction on this function** |

*Wage estimate: Argentine CCT full-time retail/admin rate, Ministerio de Trabajo 2025. Hours/week: model estimate from operator interviews. Exchange rate: ARS 1,250/USD (June 2026 official BNA).*

**Why Google Marketplace** (stats verified against [Google Cloud Blog, Jun 2025](https://cloud.google.com/blog/products/ai-machine-learning/partner-built-agents-available-in-gemini-enterprise)):
- Marketplace vendors close deals **112% larger** than off-marketplace (Futurum whitepaper cited therein)
- Purchasing cycles accelerate **up to 50% faster**
- **$460B+** committed enterprise spend available to Marketplace partners

#### The Opportunity

Latin America's retail e-commerce market reached **$191.25 billion in 2025** — the world's fastest-growing retail e-commerce market in 2025, outpacing global growth at 12.2% year-over-year ([eMarketer, 2025](https://www.emarketer.com/content/latin-america-ecommerce-forecast-2025-growth-outlook-argentina-brazil-mexico)). In Argentina alone, e-commerce billing grew 181% in 2024 ([CACE Annual Study 2024](https://cace.org.ar/blogs/news/estudio-anual-de-cace-2024-el-ecommerce-en-argentina-alcanzo-los-22-billones-en-facturacion)). On the B2B side, the LATAM B2B e-commerce market was valued at **$694 billion in 2024**, growing at a 23.9% CAGR through 2033 ([Straits Research, LATAM B2B E-commerce Market report (2024)](https://web.archive.org/web/2024/https://straitsresearch.com/report/b2b-ecommerce-market/latam)).

The growth is real. The coordination infrastructure to support it is not. The SMB and distributor segment — the backbone of LATAM retail — still runs on phone calls, WhatsApp threads, and spreadsheets bridging incompatible systems. Every order taken by a sales rep involves a manual chain: check stock, confirm price, collect payment, generate an electronic invoice against ARCA, hand off to a logistics carrier, follow up on delivery. Each step is a potential failure point, and each failure costs staff time or customer trust.

The concrete, validated pain is **employee turnover and training cost**. Based on Velora's experience in the LATAM frontline retail segment, turnover rates are persistently high — and replacing an employee can cost between one-half and two times their annual salary ([Gallup](https://www.gallup.com/workplace/247391/fixable-problem-costs-businesses-trillion.aspx)). Velora eliminates the training burden for routine operations — recording a sale, checking stock, issuing a payment link, quoting a shipment — because the Companion agent (shelved, architecture complete) guides the employee through every step in plain language, with no system knowledge required.

#### The End-to-End Agentic Commerce Loop

What differentiates Velora is not any single capability but the **demonstrable end-to-end workflow** — autonomous agents handling the entire commerce cycle with zero human bridges. Velora operates three human-facing agents: the **Customer Agent** serves the end customer over WhatsApp (B2C), the **Supervisor** serves the owner (orchestrates, decides, provides insights), and the **Companion** (shelved) serves the employee at the counter.

The full loop, triggered by a customer WhatsApp message — no human in the loop:

1. **Customer Agent (Gemini 2.5 Flash)** attends the customer on WhatsApp, resolves the order against the live catalog (the business's real inventory is grounded into the agent's context), collects a delivery address, and routes to the Logística Agent over A2A. (Vertex AI Search semantic grounding — "bolso para la espalda" → Mochila — is live on the owner-facing Supervisor path.)
2. **Logística Agent (wraps Andreani)** quotes shipping options and returns cost + ETA (demo uses Andreani in mock mode, pending per-client carrier credentials).
3. **Payments Agent (wraps MercadoPago)** generates a MercadoPago Checkout Pro payment link and sends it directly to the customer on WhatsApp — the link is real and chargeable (live MercadoPago OAuth + Preference API). The in-store dynamic QR variant is built but flag-gated off in the demo (`MP_REAL_QR_ENABLED`).
4. On payment confirmation (MercadoPago webhook), **Fiscal Agent (wraps ARCA)** emits the electronic invoice via ARCA's WSAA/WSFE SOAP protocol — no human touch required (demo runs ARCA sandbox path; real AFIP emission is flag-gated via `ARCA_REAL_MODE`).
5. **Logística Agent** creates the dispatch order and returns a tracking number to the customer (mock mode in demo).
6. **Supervisor (Gemini 2.5 Pro)** orchestrates the entire chain and push-notifies the owner (FCM + Web Push) at each milestone — payment confirmed, invoice issued, shipment dispatched.

This is not a chatbot layered on top of existing tools. It is **agent-to-agent orchestration across three external-system A2A translator agents** (MercadoPago, ARCA, Andreani) — triggered by a customer's WhatsApp message and coordinated by a Supervisor running Gemini 2.5 Pro on Vertex AI, with every step authenticated via Ed25519 JWKS and executed over the open A2A v0.3.0 protocol.

#### Who Pays and Why

The paying customer is the **merchant or distributor** — a business that today employs people specifically to bridge the coordination gaps Velora automates. The value proposition is direct: replace per-step manual labor (and the turnover cost of the people doing it) with an agent layer that scales linearly with transaction volume, not headcount. At the enterprise / distribuidora tier, the same A2A architecture extends to coordinating with downstream points of sale, upstream suppliers, and logistics networks — compounding the value with each counterparty added.

#### Google Cloud Marketplace Distribution

Velora is architected for the Track 3 mandate: packaged as a Google Cloud Marketplace listing, deployed into the customer's own GCP project (Cloud Run + Vertex AI), connected to their counterparty systems via A2A agent-card discovery. No custom integration work per customer — the A2A protocol handles discovery and authentication.

The pricing model is **per-tenant subscription**, surfaced through Google Cloud Marketplace's private offer mechanism for the enterprise tier. Google's ISV revenue share is 98% on new deals and 98.5% on renewals ([Google Cloud Marketplace Vendor Net Revenue Schedule, effective April 21, 2025](https://docs.cloud.google.com/marketplace/docs/partners/revenue-share-scenarios)), making the Marketplace a commercially viable channel, not just a distribution checkbox. Customers purchasing through the Marketplace can apply spend toward their existing Google Cloud Committed Use commitments — a meaningful procurement incentive for enterprise buyers.

#### Pricing and Unit Economics (direct SMB tier)

Tiers are anchored to verified Argentine SMB SaaS comparables (all pricing pages fetched live, June 2026):

| Tier | USD/mo | Includes | Anchor |
|---|---|---|---|
| **Kiosco** | $39 | 1 location, 3 employees, 500 WhatsApp conversations/mo, sales + inventory + cash register, MercadoPago links/QR, ARCA e-invoicing | [Fudo](https://fu.do/es-ar/precios/) Pro costs ARS 65,000/mo ≈ $45 USD with annual billing at the June 2026 exchange rate; ~$53 monthly base — Velora matches it and adds the AI layer |
| **Negocio** | $79 | 10 employees, 2,000 conversations/mo, everything in Kiosco + the autonomous WhatsApp sales agent, shipping quotes and labels, sales analytics | Below the Fudo Pro + AI add-on combo (~$83) and well below [Cliengo](https://www.cliengo.com/pricing) Premium ($119, chatbot only) |
| **Multi-sucursal** | $149 | Up to 5 locations, unlimited employees, 5,000 conversations/mo, multi-location dashboards, supplier management, priority support | [Botmaker](https://botmaker.com/es/precios) Standard charges $149 for a chatbot platform alone — Velora is the full commerce stack at the same price |

Modeled unit economics (pre-revenue estimates from public [Gemini](https://ai.google.dev/gemini-api/docs/pricing), [Cloud Run](https://cloud.google.com/run/pricing) and [Supabase](https://supabase.com/pricing) pricing): COGS per tenant lands at $14–26/month — dominated by Gemini 2.5 Pro Supervisor tokens — yielding ~65% gross margin on the entry tier and ~80–83% on the upper tiers. Deliberately **no take-rate on payments**: Argentine sellers already pay MercadoPago 4–6% per payment link; stacking a second take-rate on top would make Velora uncompetitive versus using MP directly.

**Traction, stated plainly**: Velora is pre-revenue — zero paying customers today. What exists is a live production deployment processing real sandbox transactions end-to-end (URLs above, verifiable by judges), 3,180+ commits in the contest window, and a complete operational stack (16 scheduled jobs, 11 runbooks, monitoring with alert policies). The next commercial milestone is a 10-kiosco pilot cohort in Mendoza.

#### Google Always in the Equation

Whichever door the customer enters through — the Velora App, ChatGPT, Claude, or Gemini — every action executes on Google Cloud: Gemini inference on Vertex AI, compute on Cloud Run, distribution through Google Cloud Marketplace. Velora's competitors' AI surfaces become acquisition channels for Google compute. Every sale registered via an external MCP client, every invoice emitted through a third-party agent, every customer WhatsApp order — all routed through Vertex AI inference and Cloud Run. The more Velora's tool layer spreads across AI ecosystems, the more Google Cloud compute is consumed.

#### Competitive Landscape

An Argentine SMB today stitches together a POS ([Fudo](https://fu.do/es-ar/precios/), Bistrosoft), an invoicing tool (Xubio, Contabilium), a chatbot platform (Botmaker, Cliengo) and manual WhatsApp selling. Horizontal automation tools (Zapier, Make, n8n) connect APIs, but a human still composes every workflow and none of them speak an agent protocol. Velora replaces that stack with one agent layer — and is, to our knowledge, the first product in the region to expose its commerce capabilities as discoverable A2A agents and MCP tools rather than a closed UI.

#### Why Now and Why This Moat

The timing is structural: A2A v0.3.0 is the first open, vendor-neutral agent interoperability protocol with real adoption across the major AI platforms. Building on it now means **any agent or ERP that speaks A2A can plug into Velora's network without rework** — a distribuidora running a legacy SAP instance, a logistics carrier exposing a new REST API, a downstream franchise using a different AI platform. The interoperability is the moat, not single-vendor lock-in. And because Velora's translator agents wrap industry-standard external APIs (not proprietary schemas), the same architecture extends to any market where those APIs exist.

---

### Solution

Velora's core insight is that **the coordination itself is the product.** Instead of another silo, Velora is the common language — and the translator for the systems that have no common language of their own.

The system operates on two faces. The **owner track** (Supervisor, Gemini 2.5 Pro) is the orchestrator: it handles business rules, multi-agent orchestration, payment confirmation, fiscal compliance, long-context analysis of operational patterns, and A2A federation with external agents. The **employee track** (Companion, shelved, Gemini 2.5 Flash) runs the daily operations loop: recording sales, checking stock, handling customer queries, escalating to the Supervisor when an action exceeds the employee's permission scope.

Behind the Supervisor sits a federation of A2A agents — and the decisive move is that **each specialist agent is a standards-compliant A2A translation of an external system.** The Fiscal Agent wraps ARCA's legacy SOAP interface (WSAA + WSFE) and exposes it as a clean A2A agent. The Payments Agent wraps the MercadoPago API. The Andreani Agent wraps the logistics carrier API. The Supervisor orchestrates them over signed JSON-RPC 2.0, and discovers and calls external counterparty agents via `/.well-known/agent-card.json` lookup. Whatever protocol a counterparty speaks — modern REST, decades-old SOAP, or A2A itself — Velora makes it one orchestratable agent network.

A tiered NLU pipeline ensures <200ms responses on the most common intents. On the **employee path**, a three-tier pipeline applies: Deterministic Fast Path (regex + catalog lookup, no LLM) → Gemini Flash slow path → Supervisor escalation (code-present; Companion flow shelved — not active in production). On the **owner path**, a two-tier pipeline applies: Deterministic Fast Path → Gemini Pro (the Flash middle-tier was removed 2026-05-30). The Fast Path covers >20% of traffic without any LLM call — sale recording, stock queries, price lookups, customer management.

Payment collection shows the pattern end-to-end: the owner triggers a MercadoPago charge from the chat, the customer pays via a real Checkout Pro payment link, and within seconds the owner receives a push notification confirming the payment, the invoice is recorded, and a WhatsApp receipt is sent to the customer — all without leaving Velora, and every step a coordinated call between the Supervisor and the Payments and Fiscal agents. (The in-store dynamic QR variant is implemented but flag-gated off in the current deployment; the live chargeable path is the payment link.)

---

### Architecture

Velora runs a three-runtime multi-agent system on Google Cloud.

**Runtime 1 — Cloud Run TypeScript ADK (interactive, primary):** The Supervisor holds eight A2A `FunctionTool` sub-agents that issue real A2A HTTP JSON-RPC calls to specialist agents:

| A2A Tool | Sub-Agent | Responsibility |
|---|---|---|
| `call_payments_agent` | Payments | MercadoPago QR + OAuth + payment lifecycle |
| `call_contador_agent` | Fiscal | ARCA WSAA + WSFE SOAP — electronic invoicing |
| `call_logistica_agent` | Logística | Andreani shipment quote / create / track |
| `call_ventas_agent` | Ventas | Catalog queries, cross-sell |
| `call_caja_agent` | Caja | Cash register open/close/movements |
| `call_inventario_agent` | Inventario | Stock load, adjustments, movements |
| `call_communications_agent` | Communications | WhatsApp send, template dispatch |
| `call_customer_agent` | Customer Agent | WhatsApp B2C — inbound customer checkout chain |

Note: `call_equipo_agent` is implemented but currently shelved.

Plus two additional agents: Companion (employee POS, Gemini Flash, internal, shelved) and Onboarding Agent.

**Runtime 2 — Vertex AI Agent Engine Python ADK (real commerce execution):** The Python Supervisor deployed as a `vertexai.agent_engines` Reasoning Engine connects to Velora's live MCP server via `ADK MCPToolset + StreamableHTTPConnectionParams`, loading a 5-tool commerce-demo subset (query_catalog, register_sale, create_tracked_payment_link, emit_invoice, connection_status) out of the full 51-tool surface — verified to return real catalog data, register sales, create payment links, and emit invoices — instead of reimplementing them.

**Runtime 3 — MCP Server (engine-agnostic tool layer):** 51 tools across 14 packs exposed over StreamableHTTP with HMAC auth. Any MCP-compatible engine consumes the same endpoint — no per-engine rework.

**Grounding — velora_search_agent:** Vertex AI Search Discovery Engine datastores provisioned per tenant, live in production. Semantic catalog search resolves regional synonyms and natural-language product queries.

For the full architecture diagram (Mermaid + ASCII), see [docs/ARCHITECTURE.md](./ARCHITECTURE.md).

---

### Multi-Agent System

#### Supervisor Agent (Owner-facing)

- **Model**: Gemini 2.5 Pro via Vertex AI Model Garden (`us-south1`)
- **Role**: Orchestrates all other agents. Receives owner chat turns, validates business rules (DelegationPolicy, time-based rules, condition-based triggers), dispatches A2A calls to eight specialist sub-agents via FunctionTools, and returns structured responses with action chips.
- **A2A FunctionTools**: `call_payments_agent`, `call_contador_agent`, `call_logistica_agent`, `call_ventas_agent`, `call_caja_agent`, `call_inventario_agent`, `call_communications_agent`, `call_customer_agent` (note: `call_equipo_agent` is implemented but currently shelved)
- **Runtime**: Cloud Run TypeScript ADK (primary, interactive) + Vertex AI Agent Engine Python ADK (executes real commerce via MCP tools)
- **Identity**: Ed25519 JWKS at `/api/agents/supervisor/jwks`

#### Companion Agent (Employee-facing, internal module, shelved)

- **Model**: Gemini 2.5 Flash via Vertex AI Model Garden
- **Role**: Operations assistant for employees. Guides daily operations (sales, stock, customer lookup) with permission-gated escalations to the Supervisor (B1: employee requests supervisor action; B2: supervisor proactively alerts on anomaly).
- **Skills**: `sale.create`, `stock.query`, `customer.lookup`, `escalation.request`, `onboarding.guide`
- **Design decision**: Internal module within `business-assistant`, not a separate A2A endpoint — avoids a network hop on every operator turn.
- **NLU**: Two-tier pipeline for the owner path (Deterministic Fast Path → Gemini Pro); three-tier for the employee path (Deterministic Fast Path → Gemini Flash → Supervisor escalation) (code-present; Companion flow shelved — not active in production).

#### Customer Agent (WhatsApp B2C)

- **Model**: Gemini 2.5 Flash via Vertex AI Model Garden
- **Role**: Handles inbound WhatsApp messages from end customers. Resolves product queries, collects delivery addresses, quotes shipping via Logística sub-agent over A2A, generates payment links via Payments sub-agent, and sends receipts. Runs asynchronously via Cloud Tasks (OIDC worker) — the Meta webhook returns 200 in <1s; the full checkout chain runs in the background.
- **Identity**: A2A agent card at `/api/agents/customer/agent-card`

#### Onboarding Agent

- **Model**: Gemini 2.5 Flash
- **Role**: Guided first-time business setup. Walks new merchants through catalog import, payment connection, and first-sale verification.

#### Payments Sub-Agent

- **Role**: QR payment lifecycle — generates MercadoPago QR codes, validates webhook confirmations, links payments to sales and invoices, handles refunds.
- **Skills**: `payment.qr_generate`, `payment.confirm`, `payment.refund`, `payment.status`
- **External**: MercadoPago API (OAuth 2.0, QR in-store, webhook HMAC validation)
- **Identity**: Ed25519 JWKS at `/api/agents/payments/jwks`; JSON-RPC at `/api/agents/payments/jsonrpc`

#### Fiscal Sub-Agent

- **Role**: Electronic invoice generation and tax compliance for Argentina (ARCA — WSAA + WSFE SOAP). Emits invoices on sale confirmation, maintains invoice numbering per business, handles ARCA authorization tickets (TAA).
- **Skills**: `fiscal.invoice_emit`, `fiscal.compliance_check`, `fiscal.summary`
- **External**: ARCA WSAA + WSFE SOAP (Argentina AFIP — sandbox path; real endpoint flag-gated via `ARCA_REAL_MODE`)
- **Identity**: Ed25519 JWKS at `/api/agents/fiscal/jwks`; JSON-RPC at `/api/agents/fiscal/jsonrpc`

#### Logística Sub-Agent

- **Role**: Logistics coordinator. Quotes shipment options, creates dispatch orders, and tracks delivery status. Receives delivery-event webhooks and pushes status updates back to the Supervisor.
- **Skills**: `shipment.quote`, `shipment.create`, `shipment.track`
- **External**: Andreani REST API
- **Identity**: Ed25519 JWKS at `/api/agents/logistica/jwks`; JSON-RPC at `/api/agents/logistica/jsonrpc`

#### Additional Sub-Agents (Ventas · Caja · Inventario · Communications)

Each follows the same A2A pattern: agent-card discovery, Ed25519 JWKS identity, JSON-RPC 2.0 handler. They handle catalog queries, cash register operations, stock movements, and WhatsApp messaging — all orchestrated by the Supervisor via signed A2A calls. (Equipo sub-agent is implemented but currently shelved — `call_equipo_agent` is not active in production.)

#### velora_search_agent (Grounding)

- **Role**: Wraps Vertex AI Search Discovery Engine per-tenant datastores. Live in production. Resolves natural-language and regional-synonym product queries before LLM calls — "bolso para la espalda" → Mochila, "para tomar mate" → Mate. Called by the NLU pipeline on catalog intents to ground the Supervisor's responses in real inventory.

---

### Track 3 Mandate Compliance

#### B2B Focus

Velora is a business-to-business interoperability layer by construction. Its unit of value is the coordination between a company and its counterparties — not a consumer transaction. The two-role model (Owner = orchestrator, Employee = operator) maps to a company's internal structure; the A2A agent federation is how that company coordinates outward. The Supervisor holds owner-level authority and orchestrates; the Companion holds employee-level authority with explicit escalation paths. The multi-agent system lets a company delegate operational coordination — payment collection, fiscal compliance, marketplace sync, logistics — to specialist agents, each one a translation of a counterparty system, while the owner retains control through the Supervisor.

**Evidence**: `src/app/api/business-assistant/_lib/rbac-policy.ts`, `src/app/api/business-assistant/_lib/intent-permissions.ts`, `src/domain/business-rule/policy-engine.ts`, A2A DelegationPolicy enforcement at mutation layer.

#### Cloud-Native Runtime

Velora's compute and AI stack runs on Google Cloud (primary database: Supabase Postgres — see Tech Stack):
- **Cloud Run** (`southamerica-east1`): Next.js App Router serving the chat pipeline, all agent endpoints, and API routes.
- **Vertex AI Agent Engine**: Python ADK adapter (`agent-engine/main.py`) registered as a Reasoning Engine on Vertex AI's managed runtime, queried via the streamQuery REST surface.
- **Cloud Scheduler**: 16 jobs managing business rule triggers (every 5 min), audit cleanup, and operational crons — all authenticated via `CRON_SECRET` bearer.
- **Secret Manager**: All credentials (MercadoPago tokens, VAPID keys, A2A secrets, ARCA certificates) stored in Secret Manager, never in environment files committed to source.
- **Cloud Logging**: `cloudLog()` replaces all `console.warn` calls — structured logs with trace context.

**Evidence**: `cloudbuild-dockerfile.yaml`, `Dockerfile`, `docs/AGENT_ENGINE_DEPLOY.md`, `src/lib/cloud-logger.ts`.

#### Vertex-Powered Intelligence

- **100% Google AI**: Gemini 2.5 Pro (Supervisor/Owner) + Gemini 2.5 Flash (Companion/Employee (shelved)/Customer Agent). Anthropic was intentionally removed during the contest period; the stack is single-vendor.
- **Vertex AI Agent Engine — executes real commerce**: Python ADK Supervisor deployed as a `vertexai.agent_engines` Reasoning Engine. The MCP connection is defined in `agent-engine/supervisor_agent.py` (`_build_mcp_toolset()`); `agent-engine/main.py` is the `AdkApp` entry point. Connects to Velora's live MCP server via `ADK MCPToolset + StreamableHTTPConnectionParams`, loading a 5-tool commerce-demo subset (query_catalog, register_sale, create_tracked_payment_link, emit_invoice, connection_status) out of the full 51-tool surface. This is not a stub: the Python engine is deployed and directly callable — verified to call `query_catalog` via MCP and return real catalog data. `USE_AGENT_ENGINE` gates routing live chat traffic through it (currently off to preserve interactive latency).
- **Vertex AI Search — LIVE in production**: Per-tenant Discovery Engine datastores (`velora-products-{tenant-id}`) indexed with the catalog. Semantic search is live: "bolso para la espalda" → Mochila, "para tomar mate" → Mate. The `velora_search_agent` wraps this grounding layer and is called by the NLU pipeline on catalog intents.
- **pgvector RAG**: Vertex `text-embedding-004` embeddings on Supabase Postgres for semantic customer and intent recall. Feature-flagged via `USE_EMBEDDINGS`.
- **Long-context analysis**: Gemini 2.5 Pro's 1M+ token context window used for owner analytics — year-of-sales pattern detection, inventory velocity, payment trend analysis.
- **Region routing**: Gemini 2.5 Pro routed to `us-south1` (Model Garden endpoint for Pro — not available in `southamerica-east1`); Flash routed to `southamerica-east1` for lowest latency on customer-facing turns.

**Evidence**: `src/app/api/business-assistant/_lib/model.ts`, `src/lib/adk/gemini-config.ts`, `src/lib/adk/grounding.ts`, `agent-engine/supervisor_agent.py` (MCP toolset), `agent-engine/main.py` (AdkApp entry point), `src/lib/vertex-search.ts`.

#### A2A Interoperability

Velora implements A2A v0.3.0 across 12 agent-card endpoints — 10 active (Supervisor + 8 specialist sub-agents + Customer Agent + Onboarding) + Companion (shelved) + Equipo (shelved):

- **Discovery**: Each A2A agent exposes `/.well-known/agent-card.json` (or `/agent-card`) with capability advertisement, skill definitions, authentication requirements, and JWKS URL.
- **Cryptographic identity**: Ed25519 key pairs per agent (12 key pairs provisioned in Secret Manager). Outbound messages signed; inbound messages verified. HMAC-bound per-tenant keys (derived from `A2A_SECRET`) prevent cross-tenant message leakage.
- **Transport**: JSON-RPC 2.0 over HTTPS. The Supervisor calls all eight sub-agents via real A2A HTTP round-trips (`src/lib/a2a-client.ts`), not in-process function calls.
- **Domain events**: Unidirectional event streams (S1/S2/S3 → R1/R2/R3/R4) with Zod-validated ingestion, atomic upsert on R2, OIDC enforcement on dead-letter routes, and 1-hour catch-up window via `CronCheckpoint`.
- **External federation**: The Supervisor can discover and call external counterparty agents via `/.well-known/agent-card.json` lookup — enabling B2B coordination workflows without pre-registration.
- **Protocol version**: `protocolVersion: "0.3.0"` declared in all agent cards — matches `@a2a-js/sdk` 0.3.13.

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
- **Testing**: Node.js `--test` runner (278+ unit test files) + Phase 4 integration suites + Playwright e2e

---

### Findings & Learnings

Building a multi-agent interoperability layer in production for LATAM companies surfaced several non-obvious constraints. The most significant is latency tolerance: a frontline employee at a busy counter has roughly 3 seconds of patience before abandoning a chat interaction. This forced a hard architectural decision — the Deterministic Fast Path (regex + catalog lookup, no LLM) must handle the most frequent intents. The tiered NLU pipeline emerged from this constraint, not from a theoretical design: three tiers for the employee path (Deterministic → Flash → Pro escalation) (code-present; Companion flow shelved — not active in production); two tiers for the owner path (Deterministic → Pro, after removing the Flash middle tier in 2026-05-30). Every LLM call is a gamble on latency; the Fast Path covers >20% of traffic and reduces p50 latency from ~2s to <200ms on those intents.

The A2A protocol is powerful but adds operational surface area. Cryptographic identity (Ed25519 JWKS) per agent is correct for production but requires careful key rotation, HMAC-bound per-tenant derivation, and dead-letter handling for message replay attacks. We learned that in-process function calls (the initial implementation) mask transport failures that only surface under load — replacing them with real HTTP A2A round-trips revealed several missing error paths and forced better timeout handling throughout the payment flow.

Vertex AI Agent Engine and the Cloud Run TypeScript path are not duplications — they are two complementary runtimes with distinct roles. The Cloud Run TypeScript path handles interactive chat (sub-2s p99, direct Gemini calls + A2A delegation). The Agent Engine Python path handles managed-runtime commerce execution: instead of reimplementing the same tools in Python, the Python Supervisor connects to Velora's live MCP server via `ADK MCPToolset + StreamableHTTPConnectionParams` and calls the same live MCP server the TypeScript path uses (loading a 5-tool commerce-demo subset out of the full 51-tool surface). This means a single tool implementation (the MCP server) is consumed by any engine — TypeScript, Python, or any future engine — without per-engine rework. The key insight: the MCP server is the engine-agnostic tool layer; the Agent Engine is the managed Google Cloud runtime that proves the tools work from a non-TypeScript context. This tradeoff — one canonical tool layer consumed by two runtimes — is more maintainable than a reimplemented Python copy.

Vertex AI Search going live surfaced a practical challenge: per-tenant datastore provisioning must happen at business creation time, not lazily. The `velora_search_agent` wrapper handles graceful fallback to keyword search when a datastore is not yet indexed, which kept the grounding feature shippable incrementally without a hard dependency on every tenant having a fully-indexed store.

---

### Production Rigor

Most agent demos stop at a working flow. Velora ships the operational layer around it:

| Dimension | What runs today | Evidence |
|---|---|---|
| Observability | Structured Cloud Logging with trace context on every turn; Cloud Monitoring dashboard (request count, p50/p95/p99, instances, Pub/Sub backlog, Vertex predictions) with alert policies (5xx >1%, p99 >5s) | `src/lib/cloud-logger.ts`, `scripts/deploy-tier-1-alerts.sh`, `scripts/setup-slos.sh` |
| Guardrails | Hallucination guard on Supervisor output (enforce mode); post-LLM no-stock guard on the Customer Agent; RBAC + DelegationPolicy enforced server-side at the mutation layer | `supervisor-hallucination-guard.ts`, `policy-engine.ts` |
| Money-path safety | Idempotency contract on every financial mutation (atomic insert-first, race-safe); critical-write audit events; constant-time secret comparison | `src/app/api/_lib/idempotency.ts`, `mutation-contract.ts` |
| Evaluations | Golden-dataset eval suite with adversarial rubrics (no-discount, no-credit, no-stock-hallucination), 278+ unit test files, contract checkers enforcing architectural invariants in CI | `tests/eval/golden-dataset.json`, `scripts/check-*.mjs` |
| Cost controls | DB-backed rate limiting, per-tenant demo quotas, token output caps, thinking-budget tuning, scale-to-zero Cloud Run | `rate-limit-core.ts`, `demo-quota.ts` |
| Incident response | 11 operational runbooks (diagnose → mitigate → root cause → escalate); 16 Cloud Scheduler jobs with catch-up checkpoints | `docs/RUNBOOKS.md`, `scripts/scheduler-jobs.json` |

---

### Judging Criteria — Evidence Map

#### Technical Implementation (30%)

Velora implements every mandatory Track 3 technology in verified, running production code:

| Requirement | Status | Evidence |
|---|---|---|
| Vertex AI Gemini exclusive | LIVE | `src/lib/gemini-models.ts`, `src/lib/adk/gemini-config.ts` |
| ADK orchestration (two runtimes) | LIVE | `src/lib/adk/supervisor-agent.ts` (TS) + `agent-engine/main.py` (Python) |
| Cloud Run runtime | LIVE | `cloudbuild-dockerfile.yaml`, Cloud Run `southamerica-east1` |
| Multi-agent A2A design | LIVE | 12 agent-card endpoints (10 active + 2 shelved), 8 A2A sub-agent tools, Ed25519 per-agent identity |
| Vertex AI Agent Engine | Deployed · verified (routing flag-gated) | `vertexai.agent_engines` — calls live MCP tools, verified; `USE_AGENT_ENGINE` gates interactive chat routing |
| Vertex AI Search grounding | LIVE | Per-tenant Discovery Engine datastores, semantic queries verified |
| A2A v0.3.0 protocol | LIVE | `src/app/api/a2a/`, `src/lib/a2a-client.ts`, `src/app/api/agents/*/agent-card/` |
| MCP engine-agnostic tool layer | LIVE | 51 tools, 14 packs, StreamableHTTP, consumed by both TS and Python runtimes |

#### Business Case (30%)

The market opportunity is real and sized: LATAM B2B e-commerce at $694B (2024, 23.9% CAGR), Argentina e-commerce billing +181% in 2024. The pain is validated: employee turnover in frontline LATAM retail is a documented operational cost — Velora eliminates the training burden for routine operations. The monetization model is concrete: per-tenant subscription via Google Cloud Marketplace private offers (98% ISV revenue share on new deals). The A2A interoperability is the strategic moat: any counterparty that speaks A2A can plug into the network without custom integration.

The end-to-end agentic commerce loop (WhatsApp → catalog resolution → payment link → invoice → shipment tracking → owner notification) is not a slideware scenario — it is the deployed production path, exercised end-to-end against sandbox rails and verifiable live by judges. Velora is pre-revenue (see Pricing and Unit Economics above); the honest current state is a production-grade platform awaiting its first pilot cohort.

#### Innovation (20%)

Three non-obvious decisions differentiate the architecture:

1. **MCP as the engine-agnostic tool layer**: A single tool implementation consumed by any engine (TypeScript ADK, Python ADK, Claude Code, or any future engine). The Agent Engine Python path validates this by calling live production tools — not stubs — via `MCPToolset + StreamableHTTPConnectionParams`.

2. **A2A at the translator-agent boundary**: Each external system (MercadoPago, ARCA, Andreani) is wrapped as a standards-compliant A2A agent, not a hardcoded API integration. Any company that exposes an A2A agent card can be discovered and called by the Supervisor without pre-registration — enabling true B2B agent-to-agent coordination.

3. **Deterministic Fast Path before LLM**: The tiered NLU pipeline handles >20% of traffic (sale recording, stock queries, price lookups) without any LLM call — reducing p50 latency from ~2s to <200ms on those intents. This emerged from a production constraint (operator patience at 3 seconds) and solved it architecturally, not by making the LLM faster.

#### Demo & Presentation (20%)

The demo shows the end-to-end commerce loop from a WhatsApp customer message to a confirmed invoice, running on live production infrastructure. Key moments:

1. WhatsApp B2C inbound → Customer Agent resolves the catalog query via Vertex AI Search grounding
2. Supervisor orchestrates Payments sub-agent (MercadoPago QR) → Fiscal sub-agent (ARCA invoice)
3. Agent Engine Python path calls `query_catalog` via MCP and returns live product data
4. Owner receives a real-time push notification (FCM + Web Push) at each milestone

See [docs/DEMO_VIDEO_SCRIPT.md](./DEMO_VIDEO_SCRIPT.md) for the full storyboard.

---

### Live Demo

**URL**: [somosvelora.com](https://somosvelora.com)

The landing page is publicly accessible. For full owner demo access (live QR payment flow, multi-agent orchestration, Customer Agent WhatsApp loop), contact: **soporte@somosvelora.com**

Demo environment uses MercadoPago sandbox credentials. The fiscal agent operates against ARCA sandbox (no real invoices issued during judging).

---

### Code Repository

**URL**: [github.com/crossi-dev/velora-track3](https://github.com/crossi-dev/velora-track3)

The repository will be set to public during the judging period per contest rules.

Contest period work is delineated in [docs/CONTEST_PERIOD_WORK.md](./CONTEST_PERIOD_WORK.md).

---

### Demo Video

**Submission**: The demo video will be submitted as a URL per contest instructions. See [docs/DEMO_VIDEO_SCRIPT.md](./DEMO_VIDEO_SCRIPT.md) for the full storyboard and script.

**Duration**: ≈2:16 (136 seconds, within the 180s limit)  
**Language**: English narration over the Spanish-language product UI
