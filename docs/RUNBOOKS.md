# Velora — Operational runbooks

> Diagnostic + remediation playbooks for the on-call (you) when alerting fires. Each runbook starts with the alert that triggered it, then walks through diagnosis → mitigation → root cause.

## Table of contents

- [R-01: Cloud Run 5xx rate >1%](#r-01-cloud-run-5xx-rate-1)
- [R-02: Cloud Run p99 latency >5s](#r-02-cloud-run-p99-latency-5s)
- [R-03: Pub/Sub backlog >100](#r-03-pubsub-backlog-100)
- [R-04: Vertex AI Gemini errors](#r-04-vertex-ai-gemini-errors)
- [R-05: Supabase Postgres pool exhaustion](#r-05-supabase-postgres-pool-exhaustion)
- [R-06: Pub/Sub DLQ messages](#r-06-pubsub-dlq-messages)
- [R-07: Cron job failed](#r-07-cron-job-failed)
- [R-08: Agent Engine query failures](#r-08-agent-engine-query-failures)
- [R-09: ADK Supervisor failures / model fallover](#r-09-adk-supervisor-failures--model-fallover)
- [R-10: Tier-1 money-path alert firing](#r-10-tier-1-money-path-alert-firing)
- [R-11: /api/health uptime alert](#r-11-apihealth-uptime-alert)

---

## R-01: Cloud Run 5xx rate >1%

**Alert:** "Velora — Cloud Run 5xx rate >1% over 5min"

### Diagnose (60s)

```bash
gcloud run services logs tail velora --region=southamerica-east1 --project=<your-gcp-project> \
  | grep -E '"severity":"(ERROR|CRITICAL)"' | head -20
```

Look for the dominant error pattern:

| Symptom | Likely root cause | Jump to |
|---------|-------------------|---------|
| `Vertex AI ... 429` or `RESOURCE_EXHAUSTED` | Gemini quota | R-04 |
| `Vertex AI ... 401` or `UNAUTHENTICATED` | SA misconfig | below |
| `prisma ... P1001` or `pool exhausted` | DB pool | R-05 |
| `idempotency ... P2002` | Idempotency collision (rare, transient) | wait, monitor |
| `RESOURCE_NOT_FOUND` for product/customer | App-layer 4xx misclassified | check route handler |

### Quick mitigations

**Vertex auth lost** (rare — would require IAM change):
```bash
# Verify service account still has aiplatform.user
gcloud projects get-iam-policy <your-gcp-project> --flatten="bindings[].members" \
  --filter="bindings.members:velora-runtime@<your-gcp-project>.iam.gserviceaccount.com" \
  --format="value(bindings.role)"
```
Should include `roles/aiplatform.user`. Re-grant if missing:
```bash
gcloud projects add-iam-policy-binding <your-gcp-project> \
  --member="serviceAccount:velora-runtime@<your-gcp-project>.iam.gserviceaccount.com" \
  --role="roles/aiplatform.user" --condition=None
```

**App bug** (regression in latest revision):
```bash
gcloud run services update-traffic velora --region=southamerica-east1 \
  --to-revisions=<previous-revision-name>=100 --project=<your-gcp-project>
```
Roll back to last known good. Then debug the new revision offline.

### Root-cause hunt
- Open the dashboard: https://console.cloud.google.com/monitoring/dashboards (project <your-gcp-project>).
- Look at the request_count chart's "5xx" series — does it correlate with a deploy time?
- Check Sentry: https://sentry.io/ (organization velora) — exception rate spike?

---

## R-02: Cloud Run p99 latency >5s

**Alert:** "Velora — Cloud Run p99 latency >5s over 10min"

### Diagnose

The hot path is: `request → resolveActor → Vertex Gemini → DB writes → response`. p99 spike is almost always Vertex.

```bash
# Check Vertex AI prediction latency in dashboard tile #5.
# If Vertex p99 >3s → R-04.
# If Vertex p99 fine but Cloud Run p99 high → DB or downstream chain.
```

If Vertex is fine, look for slow DB queries:

```sql
-- in Supabase Dashboard → Database → Query Editor
SELECT query, calls, mean_exec_time, max_exec_time
FROM pg_stat_statements
WHERE mean_exec_time > 500
ORDER BY mean_exec_time DESC LIMIT 20;
```

### Quick mitigations

- **Cold start contribution:** `min-instances=1` is set. Verify revision spec.
- **Concurrent requests on a hot path:** scale up.
  ```bash
  gcloud run services update velora --region=southamerica-east1 \
    --max-instances=8 --project=<your-gcp-project>
  ```
- **Vertex Pro slowness:** flip Supervisor temporarily to Flash via env:
  ```bash
  gcloud run services update velora --region=southamerica-east1 \
    --update-env-vars=GEMINI_SUPERVISOR_MODEL=gemini-2.5-flash --project=<your-gcp-project>
  ```
  Caveat: the Supervisor's analytical voice degrades; use only as a stopgap.

### Root-cause hunt
- Compare with anomaly-scan cron timing — did p99 spike at the cron firing? Often the cron contends with live traffic for DB connections.

---

## R-03: Pub/Sub backlog >100

**Alert:** "Velora — Pub/Sub backlog >100 unacked"

### Diagnose

```bash
gcloud pubsub subscriptions describe velora-employee-events-push --project=<your-gcp-project> \
  --format="value(numUndeliveredMessages,name)"
```

Then check the push delivery success rate:
```bash
gcloud pubsub subscriptions describe velora-employee-events-push --project=<your-gcp-project> \
  --format="value(deadLetterPolicy,retryPolicy)"
```

### Common causes + fixes

| Symptom | Cause | Fix |
|---------|-------|-----|
| Cloud Run 5xx in same window | Push handler is throwing | Fix the bug, redeploy. Pub/Sub auto-retries with exponential backoff |
| Cloud Run 401 in same window | OIDC validation failing | Check `pubsub-handler/route.ts` auth — issuer expected `https://accounts.google.com` |
| All 200s but backlog grows | Push subscription paused | `gcloud pubsub subscriptions update <name> --push-endpoint=<url>` to re-arm |

### Drain manually (emergency only)
```bash
gcloud pubsub subscriptions seek velora-employee-events-push \
  --time=$(date -u +%FT%TZ) --project=<your-gcp-project>
```
This skips ALL pending messages — only do this if you've confirmed the events are non-critical (e.g. SHIFT_START events that aged out of relevance).

---

## R-04: Vertex AI Gemini errors

**Symptom:** Spike in `assistant.chat` 5xx OR Sentry capturing `GoogleGenerativeAIError`.

### Diagnose

```bash
gcloud run services logs tail velora --region=southamerica-east1 \
  | grep -E "(Vertex|gemini|GoogleGenerative)" | tail -20
```

| Error | Cause | Fix |
|-------|-------|-----|
| `429 RESOURCE_EXHAUSTED` | Per-project quota | Check console → IAM → Quotas → "Generative AI API". Request increase. |
| `403 PERMISSION_DENIED` | SA lost role | See R-01 mitigation |
| `5xx INTERNAL` | Vertex regional outage | Wait — see Scenario 3 in R-09 for the Flash regional fallback. |
| Specific model `not found` | Model deprecation | Check release notes; pin a different version in env |

### Fallback path

If Vertex is wholly down (not just throttled), retry with exponential backoff first (3 attempts × 2s backoff). If still failing, check the [Vertex AI status dashboard](https://status.cloud.google.com/) for a regional outage. Then fail over to the direct-Gemini fallback path in `supervisor-runner.ts`:

```bash
gcloud run services update velora --region=southamerica-east1 \
  --update-env-vars=USE_ADK=false --project=<your-gcp-project>
```

This disables the ADK runner and routes chat turns through the direct-Gemini path in `src/app/api/supervisor/_lib/supervisor-runner.ts` — same model, lower orchestration overhead. Re-enable `USE_ADK=true` when Vertex recovers.

---

## R-05: Supabase Postgres pool exhaustion

**Symptom:** Prisma `P1001 Can't reach database server` or `Connection pool timeout`. Surfaces as Cloud Run 5xx in waves.

### Diagnose

```bash
# Check active connections in Supabase Dashboard → Database → Query Editor:
SELECT count(*), state, application_name
FROM pg_stat_activity
WHERE datname = 'postgres'
GROUP BY state, application_name;
```

Supabase pgbouncer transaction mode (port 6543) caps connections per project: ~200 client slots on Free tier. With Cloud Run `maxScale=4` × `connection_limit=10` per instance = 40 max — well below limit.

### Quick fix

Velora uses `?pgbouncer=true&connection_limit=10` in DATABASE_URL. Verify:
```bash
gcloud secrets versions access latest --secret=DATABASE_URL --project=<your-gcp-project> | grep -o 'connection_limit=[0-9]*'
```
Should print `connection_limit=10`. If different, restore via Secret Manager + redeploy.

If pool is exhausted (even with the limit applied), the cause is upstream concurrency:
- Check Cloud Run currently-serving instance count: `gcloud run services describe velora --region=southamerica-east1`
- If `maxScale` > 4 in production, lower it. 4 × 10 = 40 connections = safe.

### Root cause
Most pool exhaustion is from a long-running query holding connections. Check `pg_stat_statements` (R-02 query) for the culprit. Common: `findMany({ include: { ... deeply nested } })` without pagination.

### Supabase connection endpoints

| Endpoint | Host | Port | Use |
|----------|------|------|-----|
| Pooler (pgbouncer) | `aws-1-us-west-2.pooler.supabase.com` | `6543` | All app traffic (`DATABASE_URL`) |
| Direct | `db.<project-ref>.supabase.co` | `5432` | IPv6 only — schema migrations, Prisma introspect |

`DATABASE_URL` must include `?pgbouncer=true&connection_limit=10`. Direct connection requires IPv6; do NOT use for app traffic.

### Why not Neon (history)
Velora ran on Neon Free until 2026-05-23, when compute quota was exhausted. Migrated to Supabase Free (44 tables, pgvector + pgcrypto + uuid-ossp + citext). Cloud SQL was evaluated and declined 2026-05-21 (no scale-to-zero, 3-4x cost).

---

## R-06: Pub/Sub DLQ messages

**Alert:** Custom — set up via setup-monitoring if you add a DLQ subscription. Indicates events failed retries and gave up.

### Diagnose
```bash
gcloud pubsub subscriptions pull velora-employee-events-dlq \
  --auto-ack --limit=5 --project=<your-gcp-project> --format=json
```
Inspect the message payloads. Each will have a `deliveryAttempt` count (how many times Pub/Sub retried before DLQ).

### Mitigations
Replay DLQ:
```bash
# Pull from DLQ and re-publish to the live topic.
# Custom script — see Pub/Sub docs on dead letter handling.
```

Or accept loss and clean up:
```bash
gcloud pubsub subscriptions seek velora-employee-events-dlq --time=$(date -u +%FT%TZ) --project=<your-gcp-project>
```

### Root cause
DLQ messages mean the handler permanently failed (4xx, not 5xx — Pub/Sub retries 5xx but ACKs 4xx). Common cause: schema drift between publisher and consumer. Audit the contract (`src/lib/agent-contract.ts`) and verify the failing payload still matches.

---

## R-07: Cron job failed

**Symptom:** Cloud Scheduler job marked FAILED in console, or `/api/scheduled/<x>` 4xx/5xx logs.

### Diagnose
```bash
gcloud scheduler jobs describe <job-id> --location=southamerica-east1 \
  --project=<your-gcp-project> --format="value(state,lastAttemptTime,status)"
```

Check the last attempt's response:
```bash
gcloud run services logs tail velora --region=southamerica-east1 \
  | grep "/api/scheduled" | tail -10
```

### Common failures

| Cron | Common failure | Fix |
|------|----------------|-----|
| `audit-cleanup` | Supabase pooler exhaustion | R-05 |
| `vertex-search-reindex` | Datastore not provisioned for a tenant | First run auto-creates; re-trigger |
| `customer-embedding-refresh` | USE_EMBEDDINGS=false | Set the flag |
| `anomaly-scan` | Slow query (`pg_stat_statements`) | Add index or paginate |

Manual trigger:
```bash
gcloud scheduler jobs run <job-id> --location=southamerica-east1 --project=<your-gcp-project>
```

---

## R-08: Agent Engine query failures

**Symptom:** `queryAgentEngine` returns null repeatedly; chat falls back to local TS ADK silently.

### Diagnose
```bash
# List recent operations on the Reasoning Engine
gcloud ai operations list --region=us-central1 --project=<your-gcp-project> --limit=10
```

Check if the resource still exists:
```bash
gcloud ai reasoning-engines describe 7487309697049952256 \
  --region=us-central1 --project=<your-gcp-project>
```

### Mitigations

**Resource deleted accidentally:** redeploy via `bash scripts/deploy-agent-engine.sh`. Capture new resource name. Update Cloud Run env:
```bash
node scripts/activate-agent-engine.cjs <new-resource-name>
```

**Permission lost:** runtime SA needs `roles/aiplatform.user` (covers Reasoning Engine query). Re-grant per R-01 IAM block.

**Vertex region outage:** flip `USE_AGENT_ENGINE=false` — local TS ADK takes over.
```bash
gcloud run services update velora --region=southamerica-east1 \
  --update-env-vars=USE_AGENT_ENGINE=false --project=<your-gcp-project>
```

---

## R-09: ADK Supervisor failures / model fallover

**Symptom:** Chat returns 504 or Supervisor-level errors; ADK runner times out; Cloud Logging shows `SUPERVISOR_ADK_TIMEOUT` or `GEMINI_PRO_RATE_LIMIT`.

### Diagnose

```bash
# Recent Supervisor errors
gcloud logging read 'resource.type="cloud_run_revision" jsonPayload.action=~"SUPERVISOR" severity>=WARNING' \
  --project=<your-gcp-project> --limit=20 --format="table(timestamp,jsonPayload.action,jsonPayload.message)"
```

Check which model is active:
```bash
gcloud run services describe velora --region=southamerica-east1 --project=<your-gcp-project> \
  --format="value(spec.template.spec.containers[0].env)"
```

### Scenario 1: Gemini Pro quota exhausted (429)

Switch the Supervisor to a lower quota model:
```bash
gcloud run services update velora --region=southamerica-east1 \
  --update-env-vars=GEMINI_SUPERVISOR_MODEL=gemini-2.5-flash --project=<your-gcp-project>
```

Restore once quota resets (typically midnight PT):
```bash
gcloud run services update velora --region=southamerica-east1 \
  --update-env-vars=GEMINI_SUPERVISOR_MODEL=gemini-2.5-pro --project=<your-gcp-project>
```

### Scenario 2: ADK runner looping / hanging

Disable ADK and fall back to direct Gemini calls:
```bash
gcloud run services update velora --region=southamerica-east1 \
  --update-env-vars=USE_ADK=false --project=<your-gcp-project>
```

Re-enable once the ADK issue is identified:
```bash
gcloud run services update velora --region=southamerica-east1 \
  --update-env-vars=USE_ADK=true --project=<your-gcp-project>
```

### Scenario 3: Gemini Pro regional outage (`us-south1`)

The Supervisor is pinned to `us-south1` via `VERTEX_LOCATION_SUPERVISOR`. Fall back to the global endpoint:
```bash
gcloud run services update velora --region=southamerica-east1 \
  --update-env-vars=VERTEX_LOCATION_SUPERVISOR=us-central1 --project=<your-gcp-project>
```

---

---

## R-10: Tier-1 money-path alert firing

**Alerts covered:** `CRITICAL_WRITE_AUDIT_FAILED`, `HEALTH_DB_FAILED`, `MP_WEBHOOK_SIG_INVALID`, `MODO_WEBHOOK_AUTH_FAILED`, `ANDREANI_WEBHOOK_SIG_INVALID`, `UNHANDLED_ERROR spike`

### Diagnose

```bash
gcloud logging read 'resource.type="cloud_run_revision" jsonPayload.action="<ACTION>" severity=ERROR' \
  --project=<your-gcp-project> --limit=20 --format="table(timestamp,jsonPayload.action,jsonPayload.message,jsonPayload.stack_trace)"
```

Replace `<ACTION>` with the alert's action name (e.g. `MP_WEBHOOK_SIG_INVALID`).

### Mitigations

| Alert | Likely cause | Fix |
|-------|-------------|-----|
| `CRITICAL_WRITE_AUDIT_FAILED` | DB pool exhaustion or idempotency table schema drift | R-05; check `CriticalWriteEvent` table accessibility |
| `HEALTH_DB_FAILED` | Supabase pool exhausted / DB down | R-05 |
| `*_SIG_INVALID` spike (>3 in 5 min) | Active spoofing attack or rotated secret | Check if secret was recently rotated; verify IP; consider rate-limit tightening |
| `MODO_WEBHOOK_AUTH_FAILED` | `MODO_WEBHOOK_SECRET` rotated in MODO dashboard but not updated in Cloud Run | Rotate via: `gcloud run services update velora --region=southamerica-east1 --update-secrets MODO_WEBHOOK_SECRET=MODO_WEBHOOK_SECRET:latest --project=<your-gcp-project>` |
| `UNHANDLED_ERROR spike` | Code regression in latest deploy | Roll back revision (R-01 mitigation) |

---

## R-11: /api/health uptime alert

**Alert:** "Velora — Uptime: /api/health down"

### Diagnose (60s)

```bash
# Check if Cloud Run is serving
gcloud run services describe velora --region=southamerica-east1 --project=<your-gcp-project> \
  --format="value(status.conditions[0].message,status.latestReadyRevisionName)"

# Tail live logs
gcloud run services logs tail velora --region=southamerica-east1 --project=<your-gcp-project> | head -30
```

If `latestReadyRevisionName` shows no healthy revision, the last deploy failed.

### Quick fix

Roll back to last healthy revision:
```bash
gcloud run services update-traffic velora --region=southamerica-east1 \
  --to-revisions=<previous-revision>=100 --project=<your-gcp-project>
```

---

## One-shot monitoring setup (manual, run once per environment)

These scripts are idempotent — safe to re-run. Run in this order on a fresh environment:

```bash
# 1. SLO baselines + error rate + latency alerts
bash scripts/monitoring/setup-slos.sh

# 2. Tier-1 money-path alert policies (CRITICAL_WRITE_AUDIT_FAILED, webhook sig failures, etc.)
bash scripts/monitoring/deploy-tier-1-alerts.sh

# 3. Uptime check for /api/health
bash scripts/monitoring/setup-uptime-checks.sh
```

**Cardinality note:** Custom metrics use only bounded labels (`status_code`, `severity`, `route_scope`). Do NOT add `businessId` as a Cloud Monitoring metric label — at 100 businesses × cardinality multiplier it would exhaust the free-tier 50 custom time-series budget. Use `businessId` only in log filter queries for diagnosis.

---

---

## Standard escalation

If the runbook isn't enough:
1. Roll back to the last known-good Cloud Run revision (R-01 mitigation #2).
2. Open a Sentry issue with the error trace.
3. Tag the issue with `production-incident-<YYYYMMDD>` and link the Cloud Logging query that found it.
4. Sleep on the rollback for 24h, then debug forward in a branch.

## Drills (do these monthly)

- [ ] Rollback drill: pick a non-current revision, route 100% traffic to it, verify smoke, route back.
- [ ] DLQ replay drill: publish a malformed message to a non-prod topic, verify it lands in DLQ, replay it.
- [ ] Vertex outage drill: flip `USE_ADK=false` for 5 min, verify chat still works via direct-Gemini fallback in supervisor-runner.ts, flip back.
- [ ] Budget alert drill: lower budget threshold to 1% temporarily, verify the email lands, restore.
