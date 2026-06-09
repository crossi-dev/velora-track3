// secret-manager-tenant.ts — per-tenant Secret Manager helpers.
//
// Stores and retrieves tenant-scoped secrets using the naming convention:
//   velora-{name}-{businessId}
//
// Examples:
//   velora-arca-passphrase-clx1234…   — ARCA cert passphrase for a specific business
//
// The Google Cloud project is read from GOOGLE_CLOUD_PROJECT or GCP_PROJECT env vars.
// Cloud Run workload identity provides credentials automatically; no service account key needed.
//
// Secret versioning: storeTenantSecret always adds a new secret version.
// getTenantSecret always reads the "latest" version label.
// Caller must NOT depend on version numbers — always use "latest".

import { SecretManagerServiceClient } from "@google-cloud/secret-manager";

const client = new SecretManagerServiceClient();

function gcpProject(): string {
  const p = process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GCP_PROJECT;
  if (!p) {
    throw new Error(
      "GOOGLE_CLOUD_PROJECT (or GCP_PROJECT) is not set. " +
        "Cloud Run sets this automatically; in local dev set it in .env.local.",
    );
  }
  return p;
}

/** Canonical secret ID for a tenant-scoped credential. */
export function tenantSecretId(name: string, businessId: string): string {
  return `velora-${name}-${businessId}`;
}

/** Full Secret Manager resource name for a secret. */
function secretName(project: string, secretId: string): string {
  return `projects/${project}/secrets/${secretId}`;
}

/** Full resource name for a specific version (defaults to "latest"). */
function versionName(project: string, secretId: string, version = "latest"): string {
  return `${secretName(project, secretId)}/versions/${version}`;
}

/**
 * Stores a tenant secret value in Secret Manager.
 *
 * - If the secret doesn't exist → creates it then adds the first version.
 * - If the secret already exists → adds a new version (previous versions remain).
 *
 * Returns the Secret Manager resource name of the new version.
 * Callers should store only the secretId (velora-{name}-{businessId}) in the DB,
 * never the version path — always resolve "latest" at read time.
 */
export async function storeTenantSecret(params: {
  businessId: string;
  name: string;
  value: string;
}): Promise<string> {
  const { businessId, name, value } = params;
  const project = gcpProject();
  const secretId = tenantSecretId(name, businessId);
  const parent = `projects/${project}`;

  // Ensure the secret container exists.
  // HIGH-SEC-7: add a 90-day rotation policy so Secret Manager sets nextRotationTime
  // and operators are alerted when tenant credentials are due for rotation.
  // rotationPeriod duration proto: { seconds: N } — 7776000s = 90 days.
  // This is advisory: Secret Manager does NOT auto-rotate values; it surfaces the
  // nextRotationTime in the console and sends a Pub/Sub notification when due.
  // Existing secrets are not updated (ALREADY_EXISTS path skips createSecret).
  try {
    await client.createSecret({
      parent,
      secretId,
      secret: {
        replication: { automatic: {} },
        labels: {
          managed_by: "velora",
          tenant: businessId.toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 63),
        },
        rotation: {
          // 90 days in seconds
          rotationPeriod: { seconds: 7776000 },
        },
      },
    });
  } catch (err: unknown) {
    // 6 = ALREADY_EXISTS — fine, but REG-5: retroactively apply the 90-day
    // rotation policy to secrets created before this fix was deployed.
    // updateSecret with rotation is idempotent — safe to call every time.
    const code = (err as { code?: number }).code;
    if (code === 6) {
      await client.updateSecret({
        secret: {
          name: secretName(project, secretId),
          rotation: { rotationPeriod: { seconds: 7776000 } },
        },
        updateMask: { paths: ["rotation"] },
      }).catch(() => {
        // Non-fatal: rotation enforcement is advisory; addSecretVersion still proceeds.
      });
    } else {
      throw new Error(
        `[secret-manager-tenant] Failed to create secret ${secretId}: ${String(err)}`,
      );
    }
  }

  // Add a new version with the secret value.
  const payload = Buffer.from(value, "utf8");
  const [version] = await client.addSecretVersion({
    parent: secretName(project, secretId),
    payload: { data: payload },
  });

  if (!version.name) {
    throw new Error(`[secret-manager-tenant] addSecretVersion returned no name for ${secretId}`);
  }
  return secretId;
}

/**
 * Retrieves the latest version of a tenant secret.
 *
 * Throws a descriptive error if the secret doesn't exist (NOT_FOUND → code 5)
 * or if access is denied (PERMISSION_DENIED → code 7).
 */
export async function getTenantSecret(params: {
  businessId: string;
  name: string;
}): Promise<string> {
  const { businessId, name } = params;
  const project = gcpProject();
  const secretId = tenantSecretId(name, businessId);

  let payload: Uint8Array | null | undefined;
  try {
    const [version] = await client.accessSecretVersion({
      name: versionName(project, secretId),
    });
    const rawData = version.payload?.data;
    // Secret Manager may return string (base64) or Uint8Array depending on the SDK version.
    // Normalise to Uint8Array so the rest of the function can call Buffer.from() uniformly.
    payload = typeof rawData === "string" ? Buffer.from(rawData, "base64") : rawData ?? null;
  } catch (err: unknown) {
    const code = (err as { code?: number }).code;
    if (code === 5) {
      throw new Error(
        `[secret-manager-tenant] Secret not found: ${secretId}. ` +
          "Run the migration script or re-connect the ARCA credential.",
      );
    }
    if (code === 7) {
      throw new Error(
        `[secret-manager-tenant] Permission denied reading ${secretId}. ` +
          "Verify the Cloud Run service account has roles/secretmanager.secretAccessor.",
      );
    }
    throw new Error(
      `[secret-manager-tenant] Failed to access secret ${secretId}: ${String(err)}`,
    );
  }

  if (!payload) {
    throw new Error(`[secret-manager-tenant] Secret ${secretId} has empty payload.`);
  }

  return Buffer.from(payload).toString("utf8");
}
