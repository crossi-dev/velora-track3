# `.env.cloudrun` template — Track 3 fully-activated configuration

> Source-of-truth template for the env vars required to deploy Velora to Cloud Run with **all** Track 3 mandatory technologies turned on (ADK, Agent Engine, Vertex AI Search grounding, pgvector RAG).
>
> The actual `.env.cloudrun` is gitignored (contains secrets). Copy this template and fill in the values marked `<...>`. Operational setup scripts (deploy, Agent Engine registration, monitoring) live in the full development repository.

```ini
# ── Database ────────────────────────────────────────────────────────────
DATABASE_URL="postgresql://postgres.<supabase-project-ref>:<password>@aws-1-us-west-2.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=10"
DIRECT_URL="postgresql://postgres.<supabase-project-ref>:<password>@aws-1-us-west-2.pooler.supabase.com:5432/postgres"

# ── Auth ────────────────────────────────────────────────────────────────
AUTH_SECRET="<32+ char random secret — generate with: openssl rand -hex 32>"
NEXTAUTH_URL="https://www.somosvelora.com"
GOOGLE_CLIENT_ID="<oauth-client-id>"
GOOGLE_CLIENT_SECRET="<oauth-client-secret>"

# ── Cron / scheduled endpoints ──────────────────────────────────────────
CRON_SECRET="<32+ char random secret — separate from AUTH_SECRET>"

# ── Vertex AI / Gemini ──────────────────────────────────────────────────
GCP_PROJECT_ID="<your-gcp-project>"
VERTEX_LOCATION="us-central1"
GEMINI_MODEL="gemini-2.5-flash"
GEMINI_SUPERVISOR_MODEL="gemini-2.5-pro"

# ── Track 3 mandatory feature flags ─────────────────────────────────────
# All four turned on in production for the contest submission. Each is
# read at runtime per-call so flipping any of them doesn't require
# redeploy.

# ADK orchestration. Off = legacy Vertex client path (kept for emergency
# rollback). Default ON for the contest.
USE_ADK="true"

# Vertex AI Search grounding. Off = SQL fuzzy match only. Requires
# datastores provisioned (see docs/VERTEX_SEARCH_SETUP.md).
USE_VERTEX_SEARCH="true"

# pgvector RAG over Customer for semantic recall. Off = exact match only.
# Requires migration applied + customer-embedding-refresh cron running.
USE_EMBEDDINGS="true"

# Agent Engine routing (query path). Off = local TS ADK only (default —
# lower latency for interactive UX). Turn on AFTER deploy-agent-engine.sh
# succeeds and you've captured AGENT_ENGINE_RESOURCE_NAME below.
USE_AGENT_ENGINE="true"
AGENT_ENGINE_RESOURCE_NAME="projects/<your-gcp-project>/locations/us-central1/reasoningEngines/<id>"

# Agent Engine session service. Off = ChatMessageSessionService (Postgres).
# On = VertexAgentEngineSessionService — ADK session ops go to Agent Engine
# REST API. Independent of USE_AGENT_ENGINE; can be toggled separately.
# Requires AGENT_ENGINE_RESOURCE_NAME to be set.
USE_AGENT_ENGINE_SESSIONS="true"

# ── A2A agent identity keys ─────────────────────────────────────────────
# Each agent has an Ed25519 private key (PKCS#8 PEM) stored in Secret Manager.
# Generate a fresh keypair: node scripts/generate-agent-identity-keys.mjs
# Then upload: printf '%s' '<PEM_BLOCK>' | gcloud secrets create <SECRET_NAME> --data-file=-
# The Companion key must be provisioned before the companion/jsonrpc endpoint
# will sign or verify X-Agent-Assertion JWTs (fails-closed without the key).
AGENT_IDENTITY_KEY_COMPANION="<Ed25519 PKCS#8 PEM — generate and store in Secret Manager>"

# ── A2A bus transport ───────────────────────────────────────────────────
A2A_TRANSPORT="pubsub"
PUBSUB_TOPIC_EMPLOYEE_EVENTS="velora-employee-events"
PUBSUB_TOPIC_SUPERVISOR_NOTIFICATIONS="velora-supervisor-notifications"

# ── Offline queue (Dead Man's Switch) ───────────────────────────────────
OFFLINE_QUEUE_ENABLED="true"

# ── Web Push (owner notifications) ──────────────────────────────────────
VAPID_PUBLIC_KEY="<from web-push generate-vapid-keys>"
VAPID_PRIVATE_KEY="<from web-push generate-vapid-keys>"
VAPID_SUBJECT="mailto:soporte@somosvelora.com"

# ── WhatsApp Business API (Meta Cloud API) ──────────────────────────────
WA_PHONE_NUMBER_ID="<from Meta>"
WA_ACCESS_TOKEN="<from Meta>"
WA_VERIFY_TOKEN="<random shared secret>"

# ── Sentry ──────────────────────────────────────────────────────────────
SENTRY_DSN="https://<key>@<org>.ingest.sentry.io/<project>"
SENTRY_ENVIRONMENT="production"

# ── Observability ───────────────────────────────────────────────────────
NODE_ENV="production"
```

## Track 3 flag matrix — what each flag activates

| Flag | OFF behavior | ON behavior | Closes which gap |
|------|-------------|-------------|------------------|
| `USE_ADK` | Direct Vertex SDK call | ADK Agent + Runner (Postgres-backed sessions) | Mandatory tech #2 |
| `USE_VERTEX_SEARCH` | SQL fuzzy match only | Semantic fallback via Vertex AI Search | Mandatory tech #6 |
| `USE_EMBEDDINGS` | Exact customer match only | pgvector cosine via text-embedding-004 | Mandatory tech #7 |
| `USE_AGENT_ENGINE` | Local TS ADK in-process | Forward turns to Reasoning Engine | Mandatory tech #5 |

All four ON = full Track 3 mandatory tech configuration. All four OFF = legacy path (no contest features).

## Order of activation

The flags can be toggled independently but the natural order is:

1. **Apply migration** (`npx prisma migrate deploy`) — required for `USE_EMBEDDINGS` to find the `embedding` column.
2. **Set `USE_ADK=true`** — no infra dependency.
3. **Set `USE_VERTEX_SEARCH=true`** + provision datastores via the cron's first run.
4. **Set `USE_EMBEDDINGS=true`** + let the customer-embedding-refresh cron backfill (or manually trigger).
5. **Deploy the Agent Engine** using the operational script in the full development repository → capture `AGENT_ENGINE_RESOURCE_NAME` → set both `AGENT_ENGINE_RESOURCE_NAME` and `USE_AGENT_ENGINE=true`.
6. **Re-deploy Cloud Run** using the deployment script in the full development repository.
