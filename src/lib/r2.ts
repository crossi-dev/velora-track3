import { Storage } from "@google-cloud/storage";

// 24h TTL — Twilio fetches WhatsApp media asynchronously (CDN retries can
// happen minutes after the send call). 15min was insufficient. GCS V4 signed
// URLs cap at 7 days; 24h is the industry-standard floor for Twilio-bound media.
// Ref: https://www.twilio.com/docs/messaging/api/media-resource
//      https://cloud.google.com/storage/docs/access-control/signed-urls
const DEFAULT_EXPIRY_SECONDS = 86400; // 24 hours
// K_SERVICE is set automatically by Cloud Run. Use it to detect runtime env.
const IS_CLOUD_RUN = Boolean(process.env.K_SERVICE);
const RUNTIME_SA = "velora-runtime@my-gcp-project.iam.gserviceaccount.com";

type GcsConfig = { storage: Storage; bucket: string; serviceAccountEmail?: string };

let cachedConfig: GcsConfig | null = null;
let configured = false;

function getGcsConfig(): GcsConfig | null {
  if (configured) return cachedConfig;
  configured = true;

  const bucket = process.env.GCS_PDF_BUCKET;
  if (!bucket) return null;

  if (IS_CLOUD_RUN) {
    // In Cloud Run: use ADC (metadata server) — no private key needed.
    // The runtime SA has roles/iam.serviceAccountTokenCreator so IAM signing works.
    cachedConfig = { storage: new Storage(), bucket, serviceAccountEmail: RUNTIME_SA };
    return cachedConfig;
  }

  // Local dev: fall back to JSON credentials.
  const credJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (!credJson) return null;
  try {
    const credentials = JSON.parse(credJson) as Record<string, unknown>;
    cachedConfig = { storage: new Storage({ credentials }), bucket };
  } catch {
    // malformed credentials JSON — stay null
  }
  return cachedConfig;
}

/**
 * Upload a PDF buffer to GCS and return the bare GCS object key.
 * Returns null if GCS is not configured or the upload fails.
 *
 * Callers should persist the returned key, not a signed URL, so the reference
 * never expires. Use getSignedUrlForGcsKey to generate a fresh URL on-demand.
 */
export async function uploadPdfToGcs(
  key: string,
  pdfBuffer: Buffer,
): Promise<string | null> {
  const cfg = getGcsConfig();
  if (!cfg) return null;

  const file = cfg.storage.bucket(cfg.bucket).file(key);
  await file.save(pdfBuffer, { contentType: "application/pdf" });
  return key;
}

/**
 * Generate a short-lived signed GET URL for a GCS object key.
 * Returns null if GCS is not configured or signing fails.
 *
 * Call this on-demand (at request time) rather than persisting the URL.
 * Default TTL: 24 hours — covers Twilio async media fetch + CDN retries (see DEFAULT_EXPIRY_SECONDS).
 */
export async function getSignedUrlForGcsKey(
  key: string,
  expiresInSeconds: number = DEFAULT_EXPIRY_SECONDS,
): Promise<string | null> {
  const cfg = getGcsConfig();
  if (!cfg) return null;

  const file = cfg.storage.bucket(cfg.bucket).file(key);
  const signOptions = {
    action: "read" as const,
    expires: Date.now() + expiresInSeconds * 1000,
    version: "v4" as const,
    ...(cfg.serviceAccountEmail ? { serviceAccountEmail: cfg.serviceAccountEmail } : {}),
  };

  const [signedUrl] = await file.getSignedUrl(signOptions);
  return signedUrl;
}

/**
 * @deprecated Use uploadPdfToGcs + getSignedUrlForGcsKey instead.
 * Kept for callers that have not yet been migrated. Generates a signed URL
 * immediately after upload — the URL expires in DEFAULT_EXPIRY_SECONDS (24h).
 */
export async function uploadPdfAndGetSignedUrl(
  key: string,
  pdfBuffer: Buffer,
  expiresInSeconds: number = DEFAULT_EXPIRY_SECONDS
): Promise<string | null> {
  const gcsKey = await uploadPdfToGcs(key, pdfBuffer);
  if (!gcsKey) return null;
  return getSignedUrlForGcsKey(gcsKey, expiresInSeconds);
}

/**
 * Generate a fresh signed URL for an Andreani label stored in GCS.
 *
 * Pass the raw `labelPdfPath` from the AndreaniShipment row. If the value is
 * a bare GCS key (starts with "pdfs/"), a new signed URL is generated. If the
 * value is an external URL (sandbox/mock fallback) it is returned as-is.
 * Returns null when GCS is not configured or the path is null.
 */
export async function getAndreaniLabelSignedUrl(
  labelPdfPath: string | null | undefined,
  expiresInSeconds: number = DEFAULT_EXPIRY_SECONDS,
): Promise<string | null> {
  if (!labelPdfPath) return null;
  // External (mock/sandbox) URL — no signing needed.
  if (labelPdfPath.startsWith("http://") || labelPdfPath.startsWith("https://")) {
    return labelPdfPath;
  }
  return getSignedUrlForGcsKey(labelPdfPath, expiresInSeconds);
}

/**
 * Build a tenant-isolated GCS object key for a PDF.
 * Format: pdfs/{type}/{businessId}/{number-or-id}.pdf
 *
 * businessId is required so two tenants with the same invoice/tracking
 * number never overwrite each other's objects in the shared bucket.
 */
export function buildPdfR2Key(
  type: string,
  businessId: string,
  id: string,
  documentNumber?: string,
): string {
  const number = documentNumber
    ? documentNumber.replace(/^(PRES-|FC-|REC-)/, "")
    : id.slice(0, 8);
  return `pdfs/${type}/${businessId}/${number}.pdf`;
}
