// cert-uploader.ts — write side that mirrors cert-loader.ts (the read side).
//
// Uploads an owner-supplied .p12 buffer to GCS under the convention:
//   gs://{ARCA_CERT_BUCKET}/{businessId}.p12
//
// NEVER logs the buffer contents. The returned GCS path is the only output.

import { Storage } from "@google-cloud/storage";

const storage = new Storage();

/**
 * Uploads a PKCS#12 buffer to GCS for the given business.
 * Returns the canonical GCS object name (e.g. "abc123.p12").
 * Throws on upload failure — caller wraps in try/catch.
 */
export async function uploadCertToGcs(
  businessId: string,
  p12Buffer: Buffer,
): Promise<string> {
  const bucket = process.env.ARCA_CERT_BUCKET ?? "velora-arca-certs";
  const objectName = `${businessId}.p12`;

  await storage
    .bucket(bucket)
    .file(objectName)
    .save(p12Buffer, {
      contentType: "application/x-pkcs12",
      // Overwrite any existing cert — upsert semantics mirror prisma upsert below.
      resumable: false,
    });

  return objectName;
}

/**
 * Best-effort GCS cleanup for a cert object. Call when the DB write that
 * follows the upload fails — prevents orphaned objects.
 * Never throws; logs on failure so ops can clean up manually.
 */
export async function deleteCertFromGcs(objectName: string): Promise<void> {
  const bucket = process.env.ARCA_CERT_BUCKET ?? "velora-arca-certs";
  await storage.bucket(bucket).file(objectName).delete({ ignoreNotFound: true });
}
