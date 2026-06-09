import "server-only";
// Vertex text-embedding-004 client. 768-dim embeddings used for the
// pgvector RAG layer (customer semantic recall). Other embedding tasks
// (product matching) go through Vertex AI Search; this is the rawer
// path for cases where we own the storage.
//
// Auth: Application Default Credentials inherited from Cloud Run service
// account. Never API-key based.

import { GoogleAuth } from "google-auth-library";

const PROJECT_ID = process.env.GCP_PROJECT_ID || "my-gcp-project";
const LOCATION = process.env.VERTEX_LOCATION || "us-central1";
const MODEL = process.env.EMBEDDING_MODEL || "text-embedding-004";

let cachedAuth: GoogleAuth | null = null;
function getAuth() {
  if (!cachedAuth) {
    cachedAuth = new GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/cloud-platform"],
    });
  }
  return cachedAuth;
}

export function isEmbeddingsEnabled(): boolean {
  return process.env.USE_EMBEDDINGS === "true";
}

interface EmbedResult {
  vector: number[];
  dimensions: number;
}

/**
 * Embed a single text into a 768-d vector. Returns null if disabled,
 * empty input, or upstream error.
 *
 * Truncates input at 2048 tokens (~8KB chars) — Vertex limit. Caller
 * should pre-shape the input to "name | recent context" before calling.
 */
export async function embedText(text: string, opts?: { timeoutMs?: number }): Promise<EmbedResult | null> {
  if (!isEmbeddingsEnabled()) return null;
  const trimmed = (text || "").trim().slice(0, 8000);
  if (!trimmed) return null;

  const url =
    `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT_ID}` +
    `/locations/${LOCATION}/publishers/google/models/${MODEL}:predict`;

  const body = {
    instances: [{ task_type: "RETRIEVAL_DOCUMENT", content: trimmed }],
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? 4000);

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

    if (!res.ok) return null;

    const data = await res.json() as {
      predictions?: Array<{ embeddings?: { values?: number[] } }>;
    };

    const vector = data.predictions?.[0]?.embeddings?.values;
    if (!Array.isArray(vector) || vector.length === 0) return null;
    return { vector, dimensions: vector.length };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Embed a query (RETRIEVAL_QUERY task type — distinct from RETRIEVAL_DOCUMENT).
 * Use for the search side; embedText() above is for indexing the corpus.
 * Score-comparable embeddings require matching task types per Vertex docs.
 */
export async function embedQuery(text: string, opts?: { timeoutMs?: number }): Promise<EmbedResult | null> {
  if (!isEmbeddingsEnabled()) return null;
  const trimmed = (text || "").trim().slice(0, 8000);
  if (!trimmed) return null;

  const url =
    `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT_ID}` +
    `/locations/${LOCATION}/publishers/google/models/${MODEL}:predict`;

  const body = {
    instances: [{ task_type: "RETRIEVAL_QUERY", content: trimmed }],
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? 1500);

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

    if (!res.ok) return null;

    const data = await res.json() as {
      predictions?: Array<{ embeddings?: { values?: number[] } }>;
    };

    const vector = data.predictions?.[0]?.embeddings?.values;
    if (!Array.isArray(vector) || vector.length === 0) return null;
    return { vector, dimensions: vector.length };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Format a vector array as a pgvector literal string `[1.0,2.0,...]`. */
export function toPgVectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}
