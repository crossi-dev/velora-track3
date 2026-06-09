import "server-only";
// Vertex AI Search (Discovery Engine) client para grounding semántico del
// catálogo de productos por business.
//
// El matching actual es
// SQL fuzzy (Levenshtein + substring), bueno para typos y mediocre para
// sinónimos regionales argentinos (destornillador/desarmador, gaseosa/coca,
// etc). Vertex AI Search aporta retrieval semántico con embeddings managed.
//
// Política:
//   - Per-tenant datastore: cada business tiene su propio Search Datastore.
//     Schema: { id, name, description, sku, barcode, businessId }.
//   - Activado por flag runtime `USE_VERTEX_SEARCH=true`. Default = legacy
//     (SQL fuzzy). Si Vertex Search está caído, devolvemos null y el caller
//     downgradea graciosamente.
//   - Auth via Application Default Credentials (Cloud Run service account
//     ya tiene roles/discoveryengine.editor).
//
// Setup operacional: ver docs/VERTEX_SEARCH_SETUP.md (datastore creation +
// daily reindex cron).

import { GoogleAuth } from "google-auth-library";

const PROJECT_ID = process.env.GCP_PROJECT_ID || "my-gcp-project";
const LOCATION = process.env.VERTEX_SEARCH_LOCATION || "global";
const COLLECTION = "default_collection";

interface VertexSearchHit {
  id: string;
  name: string;
  score: number;
}

let cachedAuth: GoogleAuth | null = null;
function getAuth() {
  if (!cachedAuth) {
    cachedAuth = new GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/cloud-platform"],
    });
  }
  return cachedAuth;
}

export function isVertexSearchEnabled(): boolean {
  return process.env.USE_VERTEX_SEARCH === "true";
}

function datastoreId(businessId: string): string {
  // Datastore IDs only allow lowercase + digits + hyphens, max 63 chars.
  // businessId is a 32-char hex from cuid — we prefix to namespace and
  // truncate defensively.
  // 63 char total cap. "velora-products-" prefix = 16 chars → leave 47 for tenant slug.
  const safe = businessId.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 40);
  return `velora-products-${safe}`;
}

function endpoint(businessId: string): string {
  const dsId = datastoreId(businessId);
  return (
    `https://discoveryengine.googleapis.com/v1/projects/${PROJECT_ID}` +
    `/locations/${LOCATION}/collections/${COLLECTION}/dataStores/${dsId}` +
    `/servingConfigs/default_search:search`
  );
}

/**
 * Semantic search over a business's product catalog. Returns up to `topK`
 * hits sorted by relevance score, or null if Vertex AI Search is disabled,
 * the datastore doesn't exist yet, or the request errors.
 *
 * Caller is expected to apply a score threshold (recommended ≥0.7) before
 * trusting a result. Below that threshold prefer escalating to clarification
 * over guessing.
 */
export async function searchProductsSemantically(args: {
  businessId: string;
  query: string;
  topK?: number;
  timeoutMs?: number;
}): Promise<VertexSearchHit[] | null> {
  if (!isVertexSearchEnabled()) return null;
  const { businessId, query, topK = 5, timeoutMs = 1500 } = args;
  if (!businessId || !query || query.trim().length < 2) return null;

  const url = endpoint(businessId);
  const body = {
    query,
    pageSize: topK,
    spellCorrectionSpec: { mode: "AUTO" },
    contentSearchSpec: { snippetSpec: { returnSnippet: false } },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const auth = getAuth();
    const client = await auth.getClient();
    const tokenResp = await client.getAccessToken();
    const token = typeof tokenResp === "string" ? tokenResp : tokenResp?.token;
    if (!token) return null;

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      // 404 = datastore missing for this business → caller falls back to SQL.
      // 429/5xx = transient → also fallback. Don't throw.
      return null;
    }

    const data = await res.json() as {
      results?: Array<{
        id?: string;
        document?: {
          structData?: { id?: string; name?: string };
        };
        modelScore?: { value?: number };
      }>;
    };

    if (!Array.isArray(data.results)) return [];
    return data.results
      .map((r) => {
        const id = r.document?.structData?.id ?? r.id ?? null;
        const name = r.document?.structData?.name ?? null;
        const score = r.modelScore?.value ?? 0;
        if (!id || !name) return null;
        return { id, name, score };
      })
      .filter((h): h is VertexSearchHit => h !== null)
      .sort((a, b) => b.score - a.score);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Upsert a batch of products into a business's Vertex AI Search datastore.
 * Used by the reindex cron. Best-effort — failures logged but not thrown.
 */
export async function indexProducts(args: {
  businessId: string;
  products: Array<{
    id: string;
    name: string;
    description?: string | null;
    sku?: string | null;
    barcode?: string | null;
  }>;
}): Promise<{ ok: boolean; indexed: number; error?: string }> {
  if (!isVertexSearchEnabled()) {
    return { ok: false, indexed: 0, error: "USE_VERTEX_SEARCH disabled" };
  }
  const { businessId, products } = args;
  if (products.length === 0) return { ok: true, indexed: 0 };

  const dsId = datastoreId(businessId);
  const importUrl =
    `https://discoveryengine.googleapis.com/v1/projects/${PROJECT_ID}` +
    `/locations/${LOCATION}/collections/${COLLECTION}/dataStores/${dsId}` +
    `/branches/default_branch/documents:import`;

  try {
    const auth = getAuth();
    const client = await auth.getClient();
    const tokenResp = await client.getAccessToken();
    const token = typeof tokenResp === "string" ? tokenResp : tokenResp?.token;
    if (!token) return { ok: false, indexed: 0, error: "no_token" };

    const inlineSource = {
      documents: products.map((p) => ({
        id: p.id,
        structData: {
          id: p.id,
          name: p.name,
          description: p.description ?? "",
          sku: p.sku ?? "",
          barcode: p.barcode ?? "",
          businessId,
        },
      })),
    };

    const res = await fetch(importUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        inlineSource,
        reconciliationMode: "INCREMENTAL",
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      return { ok: false, indexed: 0, error: `http_${res.status}:${text.slice(0, 200)}` };
    }

    return { ok: true, indexed: products.length };
  } catch (err) {
    return { ok: false, indexed: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

export { datastoreId as _datastoreIdForTesting };
