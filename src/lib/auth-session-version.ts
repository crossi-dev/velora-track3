/**
 * auth-session-version.ts
 *
 * Stateless JWT invalidation via a monotonic sessionVersion counter on User.
 *
 * Pattern:
 *   1. On login, the JWT callback embeds User.sessionVersion into the token.
 *   2. On every subsequent request the JWT callback compares token.sessionVersion
 *      against DB.sessionVersion. A mismatch (or missing user) returns null,
 *      forcing NextAuth to clear the cookie and redirect to sign-in.
 *   3. invalidateUserSession() increments User.sessionVersion and evicts the
 *      in-memory cache so the next request re-reads from DB.
 *
 * Performance:
 *   The in-memory cache (Map + TTL 60 s) reduces the DB round-trip to at most
 *   one lookup per user per minute instead of one per request. Cloud Run can
 *   run multiple instances — each has its own in-memory cache. On invalidation
 *   the calling instance evicts its entry immediately; other instances evict
 *   after TTL expiry (worst case: 60 s stale window where a revoked token still
 *   passes on a different instance). Acceptable trade-off for a single-owner app.
 *
 * If you need sub-minute cross-instance invalidation, replace the Map cache
 * with a Firestore / Redis lookup using the same interface below.
 */

import { prisma } from "@/lib/prisma";

// ─── Cache ────────────────────────────────────────────────────────────────────

// TTL reduced from 60s → 5s (MEDIUM-2 fix, 2026-05-25). Tradeoff: ~12x more DB
// reads per active user per minute, but revocation takes effect within 5s on every
// Cloud Run instance instead of up to 60s. At Velora single-owner scale (<<100 RPS)
// this is the right choice — fast revocation beats minor DB overhead.
const CACHE_TTL_MS = 5_000; // 5 seconds

interface CacheEntry {
  version: number;
  cachedAt: number;
}

// Module-level singleton — shared across requests on the same Cloud Run instance.
const versionCache = new Map<string, CacheEntry>();

// Separate set for users confirmed deleted in DB — cached for CACHE_TTL_MS to
// avoid a DB round-trip (and a WARNING log) on every request while the client
// is still draining its stale JWT cookie before NextAuth clears it.
const deletedUserCache = new Set<string>();
const deletedUserCachedAt = new Map<string, number>();

function cacheGet(userId: string): number | undefined {
  const entry = versionCache.get(userId);
  if (!entry) return undefined;
  if (Date.now() - entry.cachedAt > CACHE_TTL_MS) {
    versionCache.delete(userId);
    return undefined;
  }
  return entry.version;
}

function cacheSet(userId: string, version: number): void {
  versionCache.set(userId, { version, cachedAt: Date.now() });
}

/** Returns true if this userId was recently confirmed absent from DB. */
export function isDeletedUserCached(userId: string): boolean {
  const cachedAt = deletedUserCachedAt.get(userId);
  if (cachedAt === undefined) return false;
  if (Date.now() - cachedAt > CACHE_TTL_MS) {
    deletedUserCache.delete(userId);
    deletedUserCachedAt.delete(userId);
    return false;
  }
  return true;
}

/** Marks a userId as deleted so repeated requests skip the DB lookup. */
export function cacheDeletedUser(userId: string): void {
  deletedUserCache.add(userId);
  deletedUserCachedAt.set(userId, Date.now());
}

function cacheEvict(userId: string): void {
  versionCache.delete(userId);
  deletedUserCache.delete(userId);
  deletedUserCachedAt.delete(userId);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Returns the current sessionVersion for a user, using the in-memory cache.
 * Returns null when the user does not exist in DB (deleted user).
 */
export async function getUserSessionVersion(
  userId: string
): Promise<number | null> {
  // Fast-path: user was already confirmed absent in this window.
  if (isDeletedUserCached(userId)) return null;

  const cached = cacheGet(userId);
  if (cached !== undefined) return cached;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { sessionVersion: true },
  });

  if (!user) {
    // Cache the absence so repeated requests in the same 60 s window don't hit DB.
    cacheDeletedUser(userId);
    return null;
  }

  cacheSet(userId, user.sessionVersion);
  return user.sessionVersion;
}

/**
 * Increments User.sessionVersion, immediately invalidating all existing JWTs
 * for this user. Also evicts the in-memory cache so the very next request on
 * this instance re-reads the new version from DB.
 *
 * Call this before deleting a user (db-reset.mjs) or from the
 * "Cerrar sesión en todos los dispositivos" endpoint.
 */
export async function invalidateUserSession(userId: string): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { sessionVersion: { increment: 1 } },
  });
  cacheEvict(userId);
}

// Exported for unit tests only — do not use in production code.
export const _testOnly = { cacheGet, cacheSet, cacheEvict, versionCache, deletedUserCache, deletedUserCachedAt };
