# Velora — A2A Interoperability Layer for Multi-Agent Enterprise Coordination (LATAM)

> **Google for Startups AI Agents Challenge — Track 3 submission.**
> Cashiers in Argentina type one sentence. Two Gemini agents do the work in under 1.8 seconds. Owner gets pushed only when something matters.

[![Velora CI](https://github.com/crossi-dev/velora/actions/workflows/ci.yml/badge.svg)](https://github.com/crossi-dev/velora/actions/workflows/ci.yml)

| Track 3 entry points |  |
|----------------------|--|
| **Live demo (Spanish-first, EN toggle)** | https://somosvelora.com |
| **Judge tour (always English)** | https://somosvelora.com/track3 |
| **Public agent card (A2A v0.3.0)** | https://somosvelora.com/.well-known/agent-card.json |
| **Submission writeup** | [docs/SUBMISSION_DESCRIPTION.md](./docs/SUBMISSION_DESCRIPTION.md) |
| **Architecture diagram (Mermaid)** | [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) |
| **Contest Period scope delineation** | [docs/CONTEST_PERIOD_WORK.md](./docs/CONTEST_PERIOD_WORK.md) |
| **Mandatory tech audit (per-requirement evidence)** | [docs/SUBMISSION_DESCRIPTION.md § Track 3 Mandate Compliance](./docs/SUBMISSION_DESCRIPTION.md#track-3-mandate-compliance) |

![Velora landing — English](./docs/screenshots/01-landing-en.png)

## What it is

Velora is a B2B AI-native operating system for Argentine SMB retail (kioscos, ferreterías, almacenes, verdulerías). The cashier types `vendí 2 cubiertas Firestone` and a multi-agent system fully orchestrated on Google Cloud registers the sale in under 1.8 seconds. A second agent watches every event through an A2A bus and notifies the owner only when something matters.

| | |
|---|---|
| ![Spanish landing for the Argentine target market](./docs/screenshots/02-landing-es.png) | ![Track 3 judge tour](./docs/screenshots/03-track3-judge-tour.png) |
| Spanish-first landing (`somosvelora.com`) for the Argentine target market | Always-English judge tour (`/track3`) explaining every mandatory tech with proof links |

## Why multi-agent over single-agent

A single Gemini call carrying both Employee + Supervisor system prompts runs 4-5s per turn — the cashier feels the lag and routes around the tool. The contract-based separation lets:

- **Employee Agent** (Gemini 2.5 Flash via Vertex AI) — warm "shift partner" voice. Sub-1.8s p99 by design. The only number the cashier feels.
- **Supervisor Agent** (Gemini 2.5 Pro via Vertex AI) — analytical "Operations Manager" voice. Activates on ~5% of turns via Pub/Sub. Decides notification severity (`now` / `daily` / `drop`). Routing all turns through Pro would 20× cost without 20× value.

The two agents communicate over the **A2A protocol v0.3.0** with `EmployeeEvent` and `SupervisorNotification` contracts. Both deployed to **Vertex Agent Engine** as a Python AdkApp (`projects/000000000000/locations/us-central1/reasoningEngines/REASONING_ENGINE_ID`) AND to **Cloud Run** as TypeScript ADK wrappers — flag-gated routing.

## Track 3 mandatory technologies (implemented; Vertex AI Search, pgvector RAG, and Agent Engine are feature-flagged off in prod)

| # | Mandate | Implementation |
|---|---------|----------------|
| 1 | Vertex AI Gemini exclusive | Flash + Pro via `@google-cloud/vertexai`. No OpenAI/Anthropic in the request path |
| 2 | ADK 1.0 orchestration | TypeScript on Cloud Run + Python on Agent Engine — same prompts, same agents, same A2A contract |
| 3 | Cloud Run runtime | `southamerica-east1`, min-instances=0 (scale-to-zero); warm instance enabled for the judging window via `scripts/demo-mode.mjs` |
| 4 | Multi-agent design | Employee + Supervisor with A2A JSON-RPC + Pub/Sub bus |
| 5 | Vertex Agent Engine | ReasoningEngine `REASONING_ENGINE_ID` deployed via Python ADK SDK |
| 6 | Grounding (Vertex AI Search) | Per-tenant Discovery Engine datastores + daily reindex cron — resolves `destornillador ↔ desarmador` synonyms |
| 7 | RAG (pgvector) | Vertex `text-embedding-004` (768-dim) on Supabase Postgres for customer semantic recall — strict per-tenant isolation |
| 8 | Multi-agent collab > single | Sale → Pub/Sub LOW_STOCK → Supervisor decision → Web push |

## Architecture

```
┌─ Browser (Spanish-first, EN toggle) ─────┐  ┌─ Owner mobile ────────────┐
│ Cashier types "vendí 2 cubiertas"        │  │ Gets web push when level  │
│   ↓                                      │  │  = "now"                  │
│ Cloud Run · Next.js + ADK (TS)           │  └───────────────────────────┘
│ ├─ Employee Agent (Gemini 2.5 Flash)     │             ↑
│ │   slot-fill · cross-tenant validate    │             │
│ │   sale → Postgres tx → respond <1.8s   │             │
│ ↓                                        │             │
│ publishLowStockFromSale() ─→ Pub/Sub ─→ pubsub-handler/route.ts
│                                                        │
│ Vertex Agent Engine · Python ADK                       │
│ └─ Supervisor Agent (Gemini 2.5 Pro)                   │
│     EmployeeEvent v1 contract → analytical filter →    │
│     SupervisorNotification v1 { level, message }   ────┘
│
│ Vertex AI Search          pgvector RAG          Supabase pgbouncer
│ per-tenant datastore      Customer.embedding    pgbouncer=true
│ semantic catalog match    cosine recall         tenant-isolated
│
│ Cloud Logging structured  Cloud Monitoring      Cloud Scheduler
│ a2a_transfer / RBAC /     3 alerts + dashboard  16 cron jobs
│ CROSS_TENANT_ID_REJECTED  budget $50/mo
└──────────────────────────────────────────────────────────┘
```

Mermaid version: [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md).

## Tech stack

| Layer | Technology |
|-------|-----------|
| **Intelligence** | **Gemini 2.5 Flash + 2.5 Pro via Vertex AI** (`@google-cloud/vertexai`) |
| **Orchestration** | **Google ADK 1.0** for TypeScript (`@google/adk`) + Python ADK (`google-adk` on Agent Engine) |
| **A2A** | `@a2a-js/sdk` v0.3.0 over Cloud Pub/Sub Push subscriptions with OIDC validation |
| **Grounding** | Vertex AI Search Discovery Engine (per-tenant datastores) |
| **RAG** | pgvector + Vertex `text-embedding-004` on Supabase Postgres |
| **Agent runtime** | Cloud Run (`southamerica-east1`) + Vertex Agent Engine (`us-central1`) |
| **Frontend** | Next.js 16 (App Router), React 19, TypeScript strict |
| **Database** | Supabase Postgres (pooler aws-1-us-west-2) + pgvector + Prisma 6.19 |
| **Auth** | NextAuth v5 Google OAuth (owner) + custom HMAC PIN cookie (cashier) |
| **Mobile** | Capacitor Android (native speech recognition) |
| **WhatsApp** | Meta Cloud API (primary) + Twilio (legacy fallback) with PDF attachments via Cloudflare R2 |
| **Observability** | Cloud Monitoring (3 alerts + dashboard) + Cloud Logging + Sentry |
| **Tests** | 1196 unit tests + 14 E2E (`node --test` + Puppeteer + Jest) |

## A2A protocol (Agent-to-Agent v0.3.0)

Velora is the first Spanish-language SMB-focused agent published on the [A2A Protocol](https://a2a-protocol.org) network. Any A2A-compatible client — Salesforce, SAP, AWS Bedrock AgentCore, Microsoft Agent Framework, Google's own ADK — can discover and consult Velora's supervisor without a custom integration.

```bash
# Discovery (no auth)
curl https://somosvelora.com/.well-known/agent-card.json

# Send a message (X-API-Key required)
curl -X POST https://somosvelora.com/api/a2a/jsonrpc \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $A2A_API_KEY" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "message/send",
    "params": {
      "message": {
        "kind": "message",
        "messageId": "uuid",
        "role": "user",
        "parts": [{ "kind": "text", "text": "¿qué hacés?" }]
      }
    }
  }'
```

Full A2A loopback demo: `A2A_API_KEY=<key> node scripts/a2a-demo.mjs '¿qué hacés?'`.

## Operational runbooks

8 incident playbooks in [docs/RUNBOOKS.md](./docs/RUNBOOKS.md): Cloud Run 5xx, p99 latency, Pub/Sub backlog, Vertex AI errors, Supabase Postgres pool exhaustion, DLQ messages, cron failures, Agent Engine query failures. Each: diagnose → mitigate → root cause → escalation.

Cloud Monitoring dashboard: 5 tiles (request count, latency p50/p95/p99, instance count, Pub/Sub backlog, Vertex predictions). Alert thresholds: 5xx >1%, p99 >5s, backlog >100. Email channel: `owner@example.com`.

## Deploy

```bash
# Owner runs once — interactive auth
gcloud auth login
gcloud auth application-default login

# Activate all Track 3 flags + sync schedulers + smoke
node -r dotenv/config scripts/activate-via-rest.cjs       # Cloud Run env vars
node scripts/create-scheduler-in-memory.cjs               # 2 new cron jobs
node scripts/setup-monitoring.cjs                         # 3 alert policies
node scripts/setup-dashboard.cjs                          # custom dashboard
node scripts/setup-budget.cjs                             # $50/mo budget alert

# Deploy Agent Engine (Python ADK)
bash scripts/deploy-agent-engine.sh
node scripts/activate-agent-engine.cjs <resource-name>

# Production standard (Google Cloud 2026):
# 1. Connect GitHub repo to a Cloud Build trigger
# 2. Point the trigger at cloudbuild-dockerfile.yaml
# 3. Deploy from Git events so Cloud Build supplies COMMIT_SHA / SHORT_SHA
#
# Official docs:
# - Cloud Build triggers:
#   https://docs.cloud.google.com/build/docs/triggers
# - Build from GitHub:
#   https://docs.cloud.google.com/build/docs/automating-builds/github/build-repos-from-github
# - Deploy to Cloud Run with Cloud Build:
#   https://docs.cloud.google.com/build/docs/deploying-builds/deploy-cloud-run
#
# Break-glass local run (non-canonical only if the trigger is unavailable):
gcloud builds submit --config cloudbuild-dockerfile.yaml \
  --substitutions=SHORT_SHA=$(git rev-parse --short HEAD),COMMIT_SHA=$(git rev-parse HEAD) \
  .
```

## Testing

```bash
npm test              # unit + phase4 integration
npm run test:unit     # 1196 unit tests (node --test)
npm run test:e2e      # 14 Puppeteer + Jest contract tests against deployed URL
npm run lint          # ESLint
npx tsc --noEmit      # TypeScript strict check
npm run check:guardrails  # contract verification scripts
```

## Project origin & Contest Period scope

Velora is a pre-existing Argentine SMB SaaS owned by the entrant. The Track 3 submission is the **multi-agent orchestration layer** authored exclusively during the Contest Period (April 22 – June 5, 2026): ADK wrappers, A2A protocol, Vertex AI Search grounding, pgvector RAG, and Vertex Agent Engine deployment. Track 3's own description explicitly invites this pattern: *"Got an existing agent that is ready for prime time? This track is dedicated to taking your current, functional agents and refactoring their architecture to meet the requirements of the Google Cloud ecosystem."*

The exact file/commit delineation is in [docs/CONTEST_PERIOD_WORK.md](./docs/CONTEST_PERIOD_WORK.md). A judge can verify with one command:

```bash
git log --since=2026-04-22 --oneline -- \
  src/lib/adk/ src/app/api/a2a/ src/app/api/supervisor/ \
  src/lib/vertex-search.ts src/lib/embeddings.ts src/lib/semantic-recall.ts \
  agent-engine/
```

Should print 19+ commits, all within the Contest Period.

## Environment variables

See `src/lib/env.ts` for the full list. Required for production:

- `DATABASE_URL` — Supabase Postgres
- `AUTH_SECRET` — NextAuth JWT signing key
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — Google OAuth (owner)
- `GCP_PROJECT_ID` — `my-gcp-project`
- `VERTEX_LOCATION` — `us-central1`

Track 3 feature flags — Vertex AI Search / pgvector / Agent Engine are implemented and flag-gated; disabled in the current production deployment (`USE_VERTEX_SEARCH=false`, `USE_EMBEDDINGS` / `USE_AGENT_ENGINE` unset):

- `USE_ADK` — ADK orchestration
- `USE_VERTEX_SEARCH` — semantic product matching (flag-gated off in prod)
- `USE_EMBEDDINGS` — pgvector customer recall (flag-gated off in prod)
- `USE_AGENT_ENGINE` — forward chat through Agent Engine (flag-gated off in prod)
- `AGENT_ENGINE_RESOURCE_NAME` — `projects/000000000000/locations/us-central1/reasoningEngines/REASONING_ENGINE_ID`

Optional:

- `A2A_API_KEY` — A2A endpoint auth
- `TWILIO_*` / `WHATSAPP_*` — WhatsApp integrations
- `R2_*` — PDF storage
- `A2A_PUBLIC_BASE_URL` — agent card canonical URL override (default `https://somosvelora.com`)

Full template: [docs/ENV_CLOUDRUN_TEMPLATE.md](./docs/ENV_CLOUDRUN_TEMPLATE.md).

## License

Proprietary. All rights reserved.

---

*Submitted to the [Google for Startups AI Agents Challenge](https://devpost.team/google-cloud-for-startups/hackathons/3197) — Track 3.*
