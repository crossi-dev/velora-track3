// A2A JTI nonce cache — replay protection for inbound agent assertion JWTs.
//
// Each inbound JWT carries a unique `jti` (JWT ID). After signature validation
// passes, markJtiSeen() inserts the jti into A2aJtiSeen. A P2002 (unique
// violation) on insert means the token was already accepted — replay attack.
//
// Row TTL matches the JWT exp window (60 s). The audit-cleanup cron deletes
// expired rows via cleanA2aJtiSeen() in audit-cleanup.ts.

import { prisma } from "@/lib/prisma";

// SEC-T3-CRIT-2: cap JTI length to prevent DB storage exhaustion.
// 256 chars is sufficient for any UUID, ULID, or SHA-256 hex JTI.
// Oversized JTIs are rejected with the same code path as replays so
// the caller returns 401 without revealing whether the limit was hit.
const JTI_MAX_LENGTH = 256;

/**
 * Mark a JTI as seen by inserting it into the nonce cache.
 * Throws with Prisma error code P2002 if the jti was already seen (replay).
 * Rejects outright (throws a plain Error with code P2002) if jti exceeds
 * JTI_MAX_LENGTH — callers treat both cases as 401 replay rejection.
 *
 * @param jti     - The JWT ID claim from the validated assertion.
 * @param expSec  - The `exp` claim (Unix timestamp seconds) of the JWT.
 */
export async function markJtiSeen(jti: string, expSec: number): Promise<void> {
  if (jti.length > JTI_MAX_LENGTH) {
    // Mimic Prisma unique-constraint shape so callers' P2002 checks catch this.
    const err = new Error("JTI exceeds maximum length — treating as replay rejection") as Error & { code?: string };
    err.code = "P2002";
    throw err;
  }
  const expiresAt = new Date(expSec * 1000);
  await prisma.a2aJtiSeen.create({ data: { jti, expiresAt } });
  // Callers should catch P2002 and treat it as a replay rejection.
}
