# Velora — Vertex Agent Engine Deployment Guide

This guide walks through deploying Velora's multi-agent system (Employee + Supervisor)
to Vertex AI Agent Engine using `agent-engine/deploy.py`.

## What gets deployed

`deploy.py` calls `vertexai.preview.reasoning_engines.ReasoningEngine.create()` with
an `AdkApp` wrapping both agents:

- **Supervisor** (`velora_supervisor`) — Gemini 2.5 Pro root agent
- **Employee** (`velora_employee`) — Gemini 2.5 Flash sub-agent wired via `sub_agents`

After deploy, the resource name looks like:
`projects/000000000000/locations/us-central1/reasoningEngines/<id>`

The Cloud Run app forwards traffic to Agent Engine when `USE_AGENT_ENGINE=true` and
`AGENT_ENGINE_RESOURCE_NAME` is set (see `src/lib/adk/agent-engine-client.ts`).

## Prerequisites

### GCP prerequisites

- `gcloud` CLI authenticated: `gcloud auth login`
- Application Default Credentials: `gcloud auth application-default login`
- Project: `my-gcp-project`
- Region: `us-central1` (Agent Engine is not available in southamerica-east1 yet)
- Staging bucket: `gs://my-gcp-project-agent-engine`
  - Create if missing: `gcloud storage buckets create gs://my-gcp-project-agent-engine --location=us-central1`
- Service account permissions (already granted by `scripts/deploy-gcp.sh`):
  - `roles/aiplatform.user`
  - `roles/storage.objectAdmin` (for staging bucket)

### Required env vars (set in shell before running)

| Variable | Default | Notes |
|---|---|---|
| `GCP_PROJECT_ID` | `my-gcp-project` | Vertex project |
| `VERTEX_LOCATION` | `us-central1` | Agent Engine region |
| `AGENT_ENGINE_STAGING_BUCKET` | `gs://my-gcp-project-agent-engine` | Staging bucket URI |

No secrets are needed at deploy time — the Python agents themselves call
Gemini via Vertex AI, and the Agent Engine runtime uses the project's
default service account to authenticate.

## Deployment steps

```bash
# 1. Enter the agent-engine directory
cd agent-engine

# 2. Create and activate a Python virtualenv
python -m venv .venv
# Windows:
.venv\Scripts\activate
# macOS/Linux:
source .venv/bin/activate

# 3. Install dependencies
pip install -r requirements.txt

# 4. (Optional) Smoke-test locally — does NOT deploy
python main.py

# 5. Deploy to Agent Engine (takes 5–15 min on first run)
python deploy.py

# The script prints the resource name on success, e.g.:
# Deployed to Agent Engine
#    Resource: projects/000000000000/locations/us-central1/reasoningEngines/REASONING_ENGINE_ID

# 6. Save the resource name to Cloud Run env
gcloud run services update velora \
  --region southamerica-east1 \
  --update-env-vars AGENT_ENGINE_RESOURCE_NAME=projects/000000000000/locations/us-central1/reasoningEngines/<id>

# 7. (Optional) Activate Agent Engine routing
gcloud run services update velora \
  --region southamerica-east1 \
  --update-env-vars USE_AGENT_ENGINE=true
```

## Smoke test (post-deploy)

```bash
# Get an access token
TOKEN=$(gcloud auth print-access-token)

# Replace RESOURCE_NAME with the value from step 5
RESOURCE_NAME="projects/000000000000/locations/us-central1/reasoningEngines/<id>"

curl -X POST \
  "https://us-central1-aiplatform.googleapis.com/v1/${RESOURCE_NAME}:query" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"input": {"query": "hola, cuánto stock tengo de aceite?"}}'
```

Expected: HTTP 200 with `{"output": {"text": "..."}}`.

## Re-deploy (update)

Re-run `python deploy.py` — this creates a new reasoning engine version.
Update `AGENT_ENGINE_RESOURCE_NAME` in Cloud Run to point to the new resource name.
Old reasoning engines can be deleted via the GCP console or:

```bash
gcloud ai reasoning-engines delete <id> --region=us-central1
```

## Known deployment state

- **Contest submission**: Resource deployed at
  `projects/000000000000/locations/us-central1/reasoningEngines/REASONING_ENGINE_ID`
  (referenced in `src/app/track3/page.tsx`).
- **Routing**: `USE_AGENT_ENGINE=false` by default. The Cloud Run app uses local
  TS ADK agents for interactive chat (lower latency). Agent Engine receives
  traffic when the flag is toggled.
- **Location note**: Agent Engine must run in `us-central1`. Cloud Run stays in
  `southamerica-east1`. The cross-region hop adds ~150ms — acceptable for
  async supervisor events, not ideal for interactive cashier UX.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `404 on :query` | Wrong resource name or wrong region in URL | Verify resource name format and `us-central1` in URL |
| `403 Forbidden` | SA missing `roles/aiplatform.user` | Grant role and re-authenticate |
| `timeout on deploy.py` | First deploy packaging can take 15 min | Wait; check Cloud Build logs in GCP console |
| `ModuleNotFoundError: google.adk` | Missing dep | Run `pip install -r requirements.txt` again |
| Staging bucket 404 | Bucket not created | `gcloud storage buckets create gs://my-gcp-project-agent-engine --location=us-central1` |
