# Vertex AI Agent Engine — deployment

> Closes the "Agent Engine missing" gap from `CONTEST_MANDATORY_TECH_AUDIT.md`. The same multi-agent system (Employee + Supervisor) that runs on Cloud Run is deployable to Vertex AI Agent Engine via a Python ADK adapter.

## Why both runtimes

| Runtime | Hosts | Purpose |
|---------|-------|---------|
| **Cloud Run** (TS, primary) | Next.js app + agents in `src/lib/adk/` | Sub-second interactive chat for the operator. Always-on, low latency. |
| **Vertex Agent Engine** (Python) | `agent-engine/main.py` AdkApp wrapping Employee + Supervisor | Managed agent runtime with built-in session memory, tracing, and A2A primitives. Targeted by Pub/Sub async events and the optional `USE_AGENT_ENGINE` chat path. |

The runtimes are **functionally equivalent** — same prompts, same model IDs, same A2A contract. Cloud Run is the user-facing path because:
- Velora is a Next.js TS app. Keeping the agents in the same process avoids a network hop on every interactive user turn.
- TS ADK has lower setup overhead.

Agent Engine is mandated by Track 3 and gives us:
- **Built-in observability** (Vertex AI tracing).
- **Session memory** primitive for multi-turn operator conversations.
- **Managed scaling** without configuring Cloud Run min/max instances.

## Architecture

```
                              ┌─ Cloud Run (TS) ───────────────────────────┐
Cashier types                 │  /api/business-assistant                    │
"vendí 2 cubiertas"   ──────▶ │   USE_AGENT_ENGINE=false (default)         │
                              │     └─▶ src/lib/adk/employee-agent.ts      │
                              │                                            │
                              │   USE_AGENT_ENGINE=true                    │
                              │     └─▶ src/lib/adk/agent-engine-client.ts │
                              │           └─▶ <Vertex Agent Engine>        │
                              └─────────────┬───────────────────────────────┘
                                            │
                                            ▼
                              ┌─ Vertex Agent Engine (Python) ─────────────┐
                              │  agent-engine/main.py — AdkApp             │
                              │   ├─ velora_supervisor (Gemini 2.5 Pro)    │
                              │   └─ velora_employee   (Gemini 2.5 Flash)  │
                              └────────────────────────────────────────────┘

                              [Async path — LOW_STOCK / CASH_AT_RISK]
                              Cloud Pub/Sub ─▶ pubsub-handler/route.ts
                                                 ├─ writes A2A audit
                                                 └─ (flag-gated) forwards to Agent Engine
```

## Required env vars

| Var | Default | Purpose |
|-----|---------|---------|
| `USE_AGENT_ENGINE` | `false` | Master switch on the Cloud Run side. Even when off, the agents stay deployed in Agent Engine for direct REST hits / future cutover. |
| `AGENT_ENGINE_RESOURCE_NAME` | _(empty)_ | Filled by the deploy script. Format: `projects/<id>/locations/us-central1/reasoningEngines/<id>`. |
| `GCP_PROJECT_ID` | `my-gcp-project` | Vertex project. |
| `VERTEX_LOCATION` | `us-central1` | Agent Engine region. |
| `AGENT_ENGINE_STAGING_BUCKET` | `gs://<project>-agent-engine` | Staging bucket created by the deploy script. |

## One-time setup

### 1. Authenticate

```bash
gcloud auth login
gcloud auth application-default login
gcloud config set project my-gcp-project
```

### 2. Run the deploy script

```bash
bash scripts/deploy-agent-engine.sh
```

The script:
- Enables `aiplatform.googleapis.com` and `storage.googleapis.com`.
- Creates the staging bucket `gs://my-gcp-project-agent-engine` if missing.
- Grants the runtime SA `storage.objectAdmin` on the bucket.
- Sets up a Python venv in `agent-engine/.venv/` and installs dependencies.
- Calls `agent-engine/deploy.py` which uploads the AdkApp and registers a Reasoning Engine.

First run: ~10-15 min (most of it is Cloud Build of the agent container). Subsequent runs: ~3-5 min.

### 3. Capture the resource name

The deploy script prints:

```
✅ Deployed to Agent Engine
   Resource: projects/my-gcp-project/locations/us-central1/reasoningEngines/<id>
```

Set it on Cloud Run:

```bash
gcloud run services update velora --region=southamerica-east1 \
  --update-env-vars=AGENT_ENGINE_RESOURCE_NAME=projects/my-gcp-project/locations/us-central1/reasoningEngines/<id> \
  --project=my-gcp-project
```

### 4. (Optional) Activate the chat path

```bash
gcloud run services update velora --region=southamerica-east1 \
  --update-env-vars=USE_AGENT_ENGINE=true \
  --project=my-gcp-project
```

When this is on, the `business-assistant` route forwards turns through `queryAgentEngine()` instead of running the local TS ADK path. Default is OFF — local TS path is faster (~200ms saved per turn from the avoided Agent Engine network round-trip).

## Smoke test

```bash
# Replace <resource> with the resource name from step 3.
TOKEN=$(gcloud auth application-default print-access-token)

curl -X POST \
  "https://us-central1-aiplatform.googleapis.com/v1/<resource>:query" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"input": {"query": "vendí 2 cubiertas Firestone"}}'

# Expected: 200 with { "output": { "text": "..." } } from the Supervisor
# (root agent). The output should reference the parsed sale intent or a
# slot-filling clarification, depending on the agent's interpretation.
```

## Rollback

```bash
gcloud run services update velora --region=southamerica-east1 \
  --update-env-vars=USE_AGENT_ENGINE=false \
  --project=my-gcp-project
```

Optionally delete the Reasoning Engine:

```bash
gcloud ai reasoning-engines delete <resource-id> \
  --region=us-central1 \
  --project=my-gcp-project
```

## Cost expectations

- Reasoning Engine compute: $0.00005 per second of agent execution + $0.00005 per 1K tokens. At ~3s avg turn × 1K turns/day × 30 days = 90K seconds = ~$4.50/mo. Token cost for Pro/Flash already billed.
- Storage: staging bucket holds ~30MB of artifacts. Negligible.
- Egress: managed within GCP.

Total: **~$5-10/mo** even with USE_AGENT_ENGINE=true full-time. Negligible increment on top of the existing Vertex Gemini costs.

## Why a parallel Python implementation

The TypeScript ADK SDK does not yet support `vertexai.agent_engines.AdkApp` deployment. Until it does, the contest-blessed path for Agent Engine deployment is Python ADK SDK via the stable `vertexai.agent_engines` module. We mirror the same prompts and model IDs in `agent-engine/employee_agent.py` and `agent-engine/supervisor_agent.py` so behavior parity is maintained.

The Cloud Run TS app stays the source of truth for the user-facing UX. Agent Engine hosts the same multi-agent pattern as a managed service, satisfying the Track 3 mandate without forcing a TS rewrite of the front-end.

When TS ADK adds Agent Engine support, we collapse to a single source. Until then, the prompt files in `agent-engine/prompts/` (planned) keep both paths in sync.
