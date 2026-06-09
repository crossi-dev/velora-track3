// PKCS#12 certificate loader.
//
// Reads the .p12 file from Google Cloud Storage and extracts the RSA private
// key + signing certificate.
//
// Private key: Node ≥22 crypto.createPrivateKey with format:"pkcs12".
// Certificate: node-forge pkcs12 parser — robust AFIP cert compatibility.
//
// GCS path convention: gs://velora-arca-certs/{businessId}.p12
// The bucket name is read from ARCA_CERT_BUCKET env var (default: velora-arca-certs).

import { Storage } from "@google-cloud/storage";
import { createPrivateKey, KeyObject } from "node:crypto";
import * as forge from "node-forge";

// Lazy init so tests that load this module indirectly without GCS credentials
// don't crash at import time.
let _storage: Storage | null = null;
function getStorage(): Storage {
  if (!_storage) _storage = new Storage();
  return _storage;
}

export interface ParsedCert {
  /** RSA private key object for signing. */
  privateKey: KeyObject;
  /** PEM-encoded X.509 signing certificate (to embed in CMS). */
  certPem: string;
}

/**
 * Downloads a GCS object with exponential-backoff retry on transient errors.
 * 3 attempts: immediate → 500 ms → 1 000 ms.
 * Does NOT retry 401/403/404 — those are permanent and need operator action.
 */
async function downloadWithRetry(bucket: string, objectName: string): Promise<Buffer> {
  const MAX_ATTEMPTS = 3;
  const BASE_DELAY_MS = 500;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const [contents] = await getStorage().bucket(bucket).file(objectName).download();
      return contents as Buffer;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const isPermanent = /401|403|404|not found|no such object/i.test(msg);
      if (isPermanent || attempt === MAX_ATTEMPTS) {
        throw new Error(
          `[cert-loader] Failed to download ${objectName} from gs://${bucket}: ${msg}`,
        );
      }
      await new Promise<void>((r) => setTimeout(r, BASE_DELAY_MS * attempt));
    }
  }
  // Unreachable — every iteration above returns or throws.
  throw new Error("[cert-loader] Unexpected retry loop exit.");
}

/**
 * Downloads the PKCS#12 from GCS and parses it into usable crypto objects.
 * The GCS download is retried up to 3 times on transient 5xx / network errors.
 * Throws a descriptive error when the bucket/object is missing or the
 * passphrase is wrong.
 */
export async function loadCertFromGcs(
  gcsPath: string,
  passphrase: string,
): Promise<ParsedCert> {
  const bucket = process.env.ARCA_CERT_BUCKET ?? "velora-arca-certs";

  // gcsPath may be the full object name or include the bucket prefix.
  // Convention: stored as "{businessId}.p12" inside ARCA_CERT_BUCKET.
  const objectName = gcsPath.replace(/^gs:\/\/[^/]+\//, "");

  const p12Buffer = await downloadWithRetry(bucket, objectName);

  // Node ≥22: crypto.createPrivateKey accepts { format: "pkcs12" }.
  // The PKCS#12 envelope contains both the private key and the cert chain.
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey({
      key: p12Buffer,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- @types/node doesn't expose pkcs12 format yet; valid at runtime in Node 22+
      format: "pkcs12" as any,
      passphrase,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- opts type narrower than runtime API; pkcs12 is valid at runtime
    } as any);
  } catch {
    // Do NOT include err.message — Node crypto errors can expose key material
    // or internal cipher details ("bad decrypt", "wrong final block length"…).
    // A fixed string is enough for operators to diagnose the root cause.
    throw new Error("[cert-loader] Wrong passphrase or corrupted cert.");
  }

  // Extract the leaf certificate using node-forge — production-grade PKCS#12
  // parsing with full AFIP homologación cert compatibility.
  let certPem: string;
  try {
    certPem = extractFirstCertPemFromP12(p12Buffer, passphrase);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`[cert-loader] Failed to extract certificate PEM: ${msg}`);
  }

  return { privateKey, certPem };
}

/**
 * Extracts the first X.509 certificate from a PKCS#12 buffer and returns it
 * as a PEM-encoded string.
 *
 * Uses node-forge for robust PKCS#12 parsing, handling both AFIP homologación
 * and production certs including those with CA chains.
 */
export function extractFirstCertPemFromP12(p12Buf: Buffer, passphrase: string): string {
  // node-forge works with binary strings, not Buffers.
  const p12Der = p12Buf.toString("binary");
  const p12Asn1 = forge.asn1.fromDer(p12Der);

  let p12: forge.pkcs12.Pkcs12Pfx;
  try {
    p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, passphrase);
  } catch {
    // Wrong passphrase surfaces here; avoid leaking cipher details.
    throw new Error("[cert-loader] Wrong passphrase or corrupted cert (node-forge).");
  }

  // getBags returns all bags of the requested type, keyed by bagType OID.
  const bags = p12.getBags({ bagType: forge.pki.oids.certBag });
  const certBags = bags[forge.pki.oids.certBag];

  if (!certBags || certBags.length === 0) {
    throw new Error(
      "[cert-loader] No certificate bags found in PKCS#12. " +
        "Verify the .p12 was exported with the signing certificate included.",
    );
  }

  // Take the first cert bag — for AFIP WSAA this is the leaf signing cert.
  const cert = certBags[0]?.cert;
  if (!cert) {
    throw new Error("[cert-loader] Certificate bag is empty.");
  }

  return forge.pki.certificateToPem(cert);
}
