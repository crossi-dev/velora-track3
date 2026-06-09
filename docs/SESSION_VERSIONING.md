# Session Versioning — Stateless JWT Invalidation

## Problem

Velora uses NextAuth v5 with `strategy: "jwt"`. JWTs are stateless and signed with
`NEXTAUTH_SECRET`. There is no server-side session store to consult. This creates two gaps:

1. **Deleted user with live cookie** — after `db-reset.mjs` wipes a User row, the browser
   still holds a valid signed JWT. The `jwt` callback would let the request through until
   the 7-day maxAge expires. Calling `resolveActor()` would then return null or throw,
   causing undefined behavior per route.

2. **No remote logout** — there is no way to force a sign-out on all devices (e.g., after
   a credential compromise or an ownership transfer).

## Solution

Add a monotonic counter `sessionVersion` (integer, default 1) to the `User` model.
The JWT callback in `auth.ts` embeds the current value into every new token and
compares it on every subsequent request. A mismatch causes the callback to return
`null`, which NextAuth treats as an invalid session → cookie cleared → redirect to login.

### Schema

```prisma
model User {
  // ...
  sessionVersion Int @default(1)
}
```

Existing rows default to 1. No forced logout on deploy.

### Token lifecycle

```
login
  └─ jwt({ user }) ──► reads User.sessionVersion from DB (via cache)
                       embeds token.sessionVersion = N

subsequent request
  └─ jwt({ token }) ─► reads User.sessionVersion from DB (via 60 s cache)
                       if null         → user deleted → return null → logout
                       if DB ≠ token   → version bumped → return null → logout
                       if DB === token → ok, pass through
```

### In-memory cache

`src/lib/auth-session-version.ts` keeps a module-level `Map<userId, { version, cachedAt }>`.
TTL is 60 seconds. This reduces the extra DB round-trip to at most once per minute per
user per Cloud Run instance instead of once per request.

**Trade-off**: Cloud Run can run N instances. Each has its own map. After invalidation,
the calling instance evicts immediately; other instances serve the stale cached version
for up to 60 seconds. Acceptable for a single-owner app. If sub-minute cross-instance
invalidation is needed, replace the Map with a Firestore / Redis lookup using the same
`getUserSessionVersion` / `invalidateUserSession` interface.

**Latency**: ~5–15 ms on cache miss (one `User` SELECT). On cache hit: zero extra ms.

## Helper API

```ts
import {
  getUserSessionVersion,
  invalidateUserSession,
} from "@/lib/auth-session-version";

// Read current version (cache-first)
const version = await getUserSessionVersion(userId);
// null  → user does not exist
// number → current version

// Invalidate all JWTs for a user
await invalidateUserSession(userId);
// Increments User.sessionVersion in DB + evicts local cache entry.
```

## Where to call invalidateUserSession

| Callsite | File | Notes |
|---|---|---|
| User wipe | `scripts/db-reset.mjs` | Called before the `$transaction` that deletes the row |
| Force logout endpoint | `src/app/api/auth/invalidate-all-sessions/route.ts` | POST — owner only, self |
| Future: password / credential change | TBD | Call whenever credentials change |

## Endpoint

```
POST /api/auth/invalidate-all-sessions
Authorization: cookie session (owner only)
```

Increments the caller's own `sessionVersion`. All existing JWTs for the account become
invalid on the next request. The browser that called the endpoint will be signed out
automatically on its next authenticated API call.

Response:

```json
{ "ok": true, "message": "All sessions invalidated. You will be signed out shortly." }
```

UI copy (if surfaced in Settings):

> **Cerrar sesión en todos los dispositivos (incluye este)**

## Testing

Unit tests live in `tests/unit/session-version.test.cjs`. They mock the Prisma client
via the `globalThis.prisma` singleton and cover:

- Cache read/write/eviction
- DB lookup on cache miss
- null return for deleted user
- Version increment + cache eviction after `invalidateUserSession`
- Full scenario: login → invalidate → next request fails → re-login succeeds

Run:

```bash
node --require ./tests/phase4/register.cjs --test tests/unit/session-version.test.cjs
```

## What this does NOT cover

- Employee PIN sessions — those use a separate HMAC cookie (`EMPLOYEE_COOKIE_NAME`),
  not NextAuth JWTs. Invalidation for employees is handled by deleting the `Employee`
  row or changing the PIN hash.
- Capacitor native tokens — the `/api/auth/native-session` path issues its own
  signed token (not a NextAuth JWT). Future work: add a separate version field on
  the native token if remote logout is needed there.
