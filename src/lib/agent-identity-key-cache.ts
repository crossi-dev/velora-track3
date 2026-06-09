// Agent identity key cache — extracted from agent-identity.ts (300-line cap).
//
// PEM parse + public-key derivation is cached with a 1-hour TTL.
// A 1-hour TTL means Secret Manager volume-mount key rotations take effect within
// 1 hour on each Cloud Run instance without requiring a cold start.
//
// Secret loading strategy (two-source with fallback):
//   1. File mount  — /etc/secrets/<AGENT_IDENTITY_KEY_NAME>  (preferred in prod)
//   2. Env var     — process.env[AGENT_IDENTITY_KEY_*]  (fallback + local dev)

import { readFileSync } from "fs";
import { join } from "path";
import { createPrivateKey, createPublicKey } from "crypto";
import { cloudLog } from "@/lib/cloud-logger";

export const KEY_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

export interface ParsedKeyPair {
  kid: string;
  privateKeyPem: string;
  publicKeyBase64url: string;
  cachedAt: number; // Date.now() at cache insertion time
}

// Dev-safe global cache: Next.js Fast Refresh re-evaluates modules on hot-reload,
// creating a fresh Map that effectively bypasses the 1-hour TTL in dev.
// globalThis survives module re-evaluation; production behavior is unchanged.
const g = globalThis as typeof globalThis & {
  __veloraKeyCache?: Map<string, ParsedKeyPair>;
};
if (!g.__veloraKeyCache) g.__veloraKeyCache = new Map<string, ParsedKeyPair>();
const keyPairCache = g.__veloraKeyCache;

/** Clear the in-process key cache. Used for test isolation. */
export function clearKeyPairCache(): void {
  keyPairCache.clear();
}

function readSecretFromFile(secretName: string): string | null {
  const mountPath = join("/etc/secrets", secretName);
  try {
    return readFileSync(mountPath, "utf8").trim();
  } catch {
    // ENOENT expected in local dev; fall through to env-var path.
    return null;
  }
}

/** Resolve PEM via file-mount → env-var fallback. */
function resolveAgentKeyPem(envVar: string): string | null {
  return readSecretFromFile(envVar) ?? process.env[envVar] ?? null;
}

/**
 * Load (or return from TTL cache) the parsed key pair for an agent.
 * Returns null when the key env var is absent or unparseable.
 */
export function loadKeyPair(
  agentId: string,
  envVar: string,
  kid: string,
): ParsedKeyPair | null {
  const cached = keyPairCache.get(agentId);
  if (cached && Date.now() - cached.cachedAt < KEY_CACHE_TTL_MS) return cached;
  if (cached) keyPairCache.delete(agentId);

  const raw = resolveAgentKeyPem(envVar);
  if (!raw) {
    cloudLog({
      severity: "WARNING",
      component: "A2A",
      action: "IDENTITY_KEY_MISSING",
      a2a_transfer: false,
      message: `${envVar} not set — agent identity disabled for ${agentId} (checked /etc/secrets/${envVar} and process.env)`,
      data: { agentId },
    });
    return null;
  }

  try {
    const privateKey = createPrivateKey({ key: raw, format: "pem" });
    const publicKey = createPublicKey(privateKey);
    const jwk = publicKey.export({ format: "jwk" }) as { x?: string };
    if (!jwk.x) throw new Error("JWK missing x (public key) field");

    const kp: ParsedKeyPair = {
      kid,
      privateKeyPem: raw,
      publicKeyBase64url: jwk.x,
      cachedAt: Date.now(),
    };
    keyPairCache.set(agentId, kp);
    return kp;
  } catch (err) {
    cloudLog({
      severity: "ERROR",
      component: "A2A",
      action: "IDENTITY_KEY_PARSE_ERROR",
      a2a_transfer: false,
      message: `Failed to parse ${envVar}`,
      data: { agentId, error: err instanceof Error ? err.message : String(err) },
    });
    return null;
  }
}
