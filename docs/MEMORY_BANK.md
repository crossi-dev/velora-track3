# Memory Bank — Velora Supervisor Personal Memory

## What it is

The Memory Bank persists **UX preferences and correction patterns** learned from the owner during chat sessions. The Supervisor (Gemini 2.5 Pro) retrieves the top-5 relevant memories before each turn and injects them into its context, enabling behaviour like "Owner prefers short answers" or "Owner corrected: don't show tables."

This is what Qonto calls "Analyst behavior": the AI adapts its style to the individual, not just the task.

## What is stored

Only UX/style observations are saved. Specifically:

- Explicit corrections from the owner ("no, así no", "te equivocaste")
- Explicit preferences ("respuestas más cortas", "no uses tablas", "always add prices")
- Language preferences ("respondé en inglés")

**What is NOT stored:**
- Financial data (amounts, sales, invoices)
- Customer or employee personal data
- Product prices or stock levels
- Any PII

## Architecture

```
owner turn
  └─ runOwnerSupervisor()
       ├─ buildMemoryInjection(businessId, text)   ← retrieve top-5 in parallel
       │    └─ PREFERENCIAS APRENDIDAS DEL DUEÑO block prepended to supervisor input
       ├─ runSupervisor(supervisorInput, ctx)
       └─ extractAndSaveMemory(ownerText, supAnswer, businessId)  ← fire-and-forget
```

## Feature flag

`USE_MEMORY_BANK=true` — default **false**.

When off:
- `buildMemoryInjection` returns `""` (no latency overhead)
- `extractAndSaveMemory` is a no-op
- `saveOwnerMemory`, `retrieveOwnerMemories`, `listOwnerMemories`, `deleteOwnerMemory` all return immediately
- The Settings card renders as `null`

Enable in Cloud Run:
```
gcloud run services update velora \
  --update-env-vars USE_MEMORY_BANK=true \
  --region southamerica-east1
```

## Vertex AI Agent Engine resource

```
projects/000000000000/locations/us-central1/reasoningEngines/REASONING_ENGINE_ID
```

Memory Bank REST endpoint:
```
https://us-central1-aiplatform.googleapis.com/v1/{resource}/memories
```

Auth: Cloud Run service account with `roles/aiplatform.user` (already granted).

## Retention

The Memory Bank API uses Vertex AI Agent Engine default retention (365 days as of 2026). This is not currently configurable from the Velora app — use the Vertex AI console to change retention policy if needed.

## Owner UI

Settings → Aplicación → "Memorias de Velora" card:
- Shows last 10 observations with date
- "Olvidar esta" — delete a single memory
- "Olvidar todo" — delete all memories for this owner

The card is hidden when `USE_MEMORY_BANK=false`.

## Privacy guarantees

- **Scope isolation**: every memory is scoped to `owner:{businessId}` — cross-tenant access is structurally impossible
- **No financial data**: the extractor (`extract-memory.ts`) only saves style/preference observations, never amounts or transactions
- **Owner control**: full visibility and deletion via Settings UI and `/api/memories` DELETE endpoint
- **Fail-soft**: all Memory Bank calls catch errors and return empty — a quota exhaustion or API outage never breaks the chat

## Relevant files

| File | Role |
|---|---|
| `src/lib/agent-memory-bank.ts` | Vertex AI Memory Bank REST client |
| `src/app/api/business-assistant/_lib/extract-memory.ts` | Post-turn preference extractor |
| `src/app/api/business-assistant/_lib/inject-memory.ts` | Pre-turn memory injection builder |
| `src/app/api/business-assistant/_lib/owner-handler.ts` | Wiring point: injection + extraction |
| `src/app/api/memories/route.ts` | REST API for UI (GET list, DELETE one/all) |
| `src/app/dashboard/components/SettingsMemoryCard.tsx` | Owner Settings UI card |
| `src/app/dashboard/components/SettingsAplicacionSection.tsx` | Hosts the memory card |
