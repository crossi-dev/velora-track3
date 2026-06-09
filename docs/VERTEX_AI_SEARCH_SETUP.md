# Vertex AI Search — Setup Guide

Velora uses Vertex AI Search (Discovery Engine) for per-tenant semantic product
lookup. The feature resolves Argentine regional synonyms that SQL fuzzy matching
misses (e.g. "desarmador" ↔ "destornillador", "gaseosa" ↔ "coca").

## Architecture

```
User query "vendí un desarmador"
  → Employee Agent (ADK) → search_products tool → Vertex AI Search
  → Returns { id: "prod_abc", name: "Destornillador Phillips", score: 0.87 }
  → Agent uses ID in register_sale tool
```

The ADK FunctionTool wrapper is at `src/lib/adk/grounding.ts`.
The REST client is at `src/lib/vertex-search.ts`.
Feature flag: `USE_VERTEX_SEARCH=true` (env var, default off).

## Per-tenant datastores

Each Velora business gets its own Discovery Engine datastore:
- ID format: `velora-products-{businessId}` (lowercase, max 63 chars)
- Collection: `default_collection`
- Schema: `{ id, name, description, sku, barcode, businessId }`

This provides tenant isolation — a search on tenant A never surfaces results from
tenant B.

## Manual setup steps (per new tenant)

### 1. Enable APIs

```bash
gcloud services enable discoveryengine.googleapis.com --project=my-gcp-project
```

### 2. Grant service account permission

Cloud Run's service account needs `roles/discoveryengine.editor`:

```bash
gcloud projects add-iam-policy-binding my-gcp-project \
  --member="serviceAccount:velora-run@my-gcp-project.iam.gserviceaccount.com" \
  --role="roles/discoveryengine.editor"
```

### 3. Create the datastore (via GCP console or gcloud)

```bash
# Replace BUSINESS_ID with the cuid from the Business table
BUSINESS_ID="<business_cuid>"
DATASTORE_ID="velora-products-$(echo $BUSINESS_ID | tr '[:upper:]' '[:lower:]' | head -c 40)"

gcloud alpha discovery-engine datastores create \
  --project=my-gcp-project \
  --location=global \
  --collection=default_collection \
  --display-name="Velora Products - ${BUSINESS_ID}" \
  --type=GENERIC_CONTENT \
  $DATASTORE_ID
```

Or use the GCP console:
`Discovery Engine → Data Stores → Create → Generic Content`

### 4. Initial index

Call the existing `indexProducts` function from `src/lib/vertex-search.ts`:

```typescript
import { indexProducts } from "@/lib/vertex-search";

await indexProducts({
  businessId,
  products: await prisma.product.findMany({
    where: { businessId },
    select: { id: true, name: true, description: true, sku: true, barcode: true },
  }),
});
```

### 5. Set up daily re-index (cron)

Add a Cloud Scheduler job that hits the re-index endpoint:
```
POST /api/cron/reindex-vertex-search
Authorization: Bearer ${CRON_SECRET}
```

The endpoint loops over all businesses with `USE_VERTEX_SEARCH=true` and
calls `indexProducts` for each.

### 6. Activate the feature flag

```bash
gcloud run services update velora \
  --region southamerica-east1 \
  --update-env-vars USE_VERTEX_SEARCH=true
```

## Enable ADK grounding tool

The `search_products` ADK FunctionTool is registered conditionally:

```typescript
// In employee-agent.ts (when toolContext includes grounding):
import { buildGroundingTools } from "@/lib/adk/grounding";

const groundingTools = buildGroundingTools(businessId); // returns [] if flag off
const tools = [...coreTool, ...groundingTools];
```

Currently the grounding tool is available but not wired into the agent constructor
by default. To enable it, pass `businessId` and include `buildGroundingTools(businessId)`
in the tools array when constructing the Employee agent.

## Verification

```bash
# Check if datastore exists for a business
curl -H "Authorization: Bearer $(gcloud auth print-access-token)" \
  "https://discoveryengine.googleapis.com/v1/projects/my-gcp-project/locations/global/collections/default_collection/dataStores/velora-products-<businessId>"

# Test semantic search
curl -X POST \
  -H "Authorization: Bearer $(gcloud auth print-access-token)" \
  -H "Content-Type: application/json" \
  "https://discoveryengine.googleapis.com/v1/projects/my-gcp-project/locations/global/collections/default_collection/dataStores/velora-products-<businessId>/servingConfigs/default_search:search" \
  -d '{"query": "desarmador", "pageSize": 5}'
```

## Known gaps

- Daily re-index cron endpoint is not yet implemented — products indexed manually.
- Vertex AI Search GA pricing applies after the free tier; monitor usage.
- Datastore creation is manual per-tenant — no automated provisioning on business
  onboarding yet.

## Files

| File | Purpose |
|---|---|
| `src/lib/vertex-search.ts` | REST client for Discovery Engine search + indexing |
| `src/lib/adk/grounding.ts` | ADK FunctionTool wrapper + `buildGroundingTools` factory |
| `src/app/api/cron/reindex-vertex-search/` | Re-index cron endpoint (planned) |
