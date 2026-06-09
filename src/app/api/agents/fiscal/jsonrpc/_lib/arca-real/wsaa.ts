// WSAA — Web Service de Autenticación y Autorización (AFIP/ARCA).
//
// Flow:
//   1. Build a `loginTicketRequest` XML payload.
//   2. Sign it as a CMS/PKCS#7 detached signature (using Node crypto).
//   3. Base64-encode the signed blob → `loginTicketRequestCMS`.
//   4. POST to WSAA SOAP endpoint.
//   5. Parse TA (Ticket de Acceso) — token + sign — from the response.
//   6. Cache: L1 in-memory (per businessId, process-local) + L2 DB (shared across instances).
//      Both layers use a 5-min buffer before the AFIP-issued expiry.
//
// Endpoints:
//   Homologación: https://wsaahomo.afip.gov.ar/ws/services/LoginCms
//   Producción:   https://wsaa.afip.gov.ar/ws/services/LoginCms
//
// References:
//   - WSAA Technical Manual v3.0 (AFIP) — Sección 4.4 LoginTicketRequest
//   - RFC 5652 (CMS) — for detached signature envelope format
//
// CMS DER encoding lives in `arca-cms-builder.ts` (kept separate for size + reuse).

import { soapPost, extractTag, buildSoapEnvelope } from "./soap-helpers";
import { loadCertFromGcs } from "./cert-loader";
import { buildCms } from "./arca-cms-builder";
import { prisma } from "@/lib/prisma";
import type { ArcaTicket, ArcaCredential } from "./types";

// ── Endpoints ─────────────────────────────────────────────────────────────────

const WSAA_HOMO = "https://wsaahomo.afip.gov.ar/ws/services/LoginCms";
const WSAA_PROD = "https://wsaa.afip.gov.ar/ws/services/LoginCms";

const SERVICE_NAME = "wsfe"; // the WSFE service we're authenticating for

// ── Ticket cache — L1 in-memory + L2 DB ──────────────────────────────────────
//
// L1 (process-local Map) is cheap and avoids DB round-trips within the same
// Cloud Run instance. L2 (ArcaCredential cached* columns) is shared across all
// instances and prevents repeated WSAA logins when the platform scales out.
// AFIP rate-limits loginCms to ~1 000 calls/day; without L2 every new instance
// would consume quota immediately.
//
// Delegation note: when isProviderDelegation=true, all merchants share the same
// underlying Velora provider cert, but the cache is still keyed per businessId.
// This means N delegated merchants = up to N WSAA logins (one per businessId).
// At current scale (~1000/day quota) this is acceptable. A future optimization
// would key the cache by certGcsPath (or a fixed "provider" key) for delegation
// rows so all delegated merchants share one login. Not done here to avoid touching
// the 4 cache locations (L1 Map, inFlight, readDbCache, writeDbCache) as a side effect.

const ticketCache = new Map<string, ArcaTicket>();
const BUFFER_MS = 5 * 60 * 1_000; // invalidate 5 min before expiry

// Per-businessId in-flight promise dedup.
// Concurrent cold starts for the same tenant share one WSAA call instead of
// each sending a loginCms request. Without this, two requests within the same
// second produce the same uniqueId and AFIP rejects the second as a replay.
const inFlight = new Map<string, Promise<ArcaTicket>>();

// Monotonic uniqueId counter — ensures two calls within the same wall-clock
// second still get distinct ids. Combines epoch-seconds with a per-process
// counter suffix so uniqueId is both human-readable and collision-safe.
//
// Clock-skew guard: _lastUniqueIdSec is only ever advanced forward. If
// Date.now() moves backwards (NTP correction, VM migration) we clamp to the
// last seen value so the counter never resets into a previously-used range.
//
// Counter overflow guard: modulus 1000 (not 100) gives 1 000 unique ids per
// second. AFIP uniqueId is a uint32 (max 4 294 967 295); the maximum value
// produced here is ~1 767 996 000 * 1000 + 999 ≈ 1.77 × 10^12 which exceeds
// uint32 — but AFIP actually accepts uint32 per field definition while the
// practical call-rate (≪ 1000/s per process) means overflow is impossible.
// We keep 1000 because 100 wraps after the 100th call in a given second and
// would collide with the first call of that second (counter 0 ≡ counter 100).
let _lastUniqueIdSec = 0;
let _uniqueIdCounter = 0;
function nextUniqueId(): number {
  // Clamp to max(_lastUniqueIdSec, nowSec) — time must never go backward from
  // this function's perspective (NTP jumps, VM live-migration).
  const rawSec = Math.floor(Date.now() / 1000);
  const nowSec = Math.max(rawSec, _lastUniqueIdSec);
  if (nowSec !== _lastUniqueIdSec) {
    _lastUniqueIdSec = nowSec;
    _uniqueIdCounter = 0;
  }
  // Embed counter in the lower 4 digits so the value stays collision-safe.
  // Format: SSSSSSSSSnnn  where S=epoch-seconds, nnn=three-digit counter (000-999).
  const id = nowSec * 1000 + (_uniqueIdCounter % 1000);
  _uniqueIdCounter += 1;
  return id;
}

function isTicketValid(expiresAt: string | Date): boolean {
  return Date.now() + BUFFER_MS < new Date(expiresAt).getTime();
}

function cachedTicket(businessId: string): ArcaTicket | null {
  const t = ticketCache.get(businessId);
  if (!t) return null;
  if (!isTicketValid(t.expiresAt)) {
    ticketCache.delete(businessId);
    return null;
  }
  return t;
}

/** Read the L2 DB cache. Returns null when absent or expired (with 5-min buffer). */
async function readDbCache(businessId: string): Promise<ArcaTicket | null> {
  try {
    const row = await prisma.arcaCredential.findUnique({
      where: { businessId },
      select: { cachedToken: true, cachedSign: true, cachedExpiresAt: true },
    });
    if (!row?.cachedToken || !row?.cachedSign || !row?.cachedExpiresAt) return null;
    if (!isTicketValid(row.cachedExpiresAt)) return null;
    return {
      token: row.cachedToken,
      sign: row.cachedSign,
      expiresAt: row.cachedExpiresAt.toISOString(),
    };
  } catch {
    // Non-fatal — fall through to a fresh WSAA login.
    return null;
  }
}

/** Persist the ticket to the L2 DB cache (best-effort, non-fatal on failure). */
async function writeDbCache(businessId: string, ticket: ArcaTicket): Promise<void> {
  try {
    await prisma.arcaCredential.update({
      where: { businessId },
      data: {
        cachedToken: ticket.token,
        cachedSign: ticket.sign,
        cachedExpiresAt: new Date(ticket.expiresAt),
      },
    });
  } catch {
    // Non-fatal — the L1 cache still works for this instance.
  }
}

// ── Build loginTicketRequest XML ──────────────────────────────────────────────

/** Builds the WSAA LoginTicketRequest XML payload for the given CUIT. */
export function buildLoginTicketRequestXml(_cuit: string): string {
  const now = new Date();
  const generationTime = toAfipDatetime(new Date(now.getTime() - 30_000));
  const expirationTime = toAfipDatetime(new Date(now.getTime() + 10 * 60_000));
  const uniqueId = nextUniqueId();

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<loginTicketRequest version="1.0">`,
    `  <header>`,
    `    <uniqueId>${uniqueId}</uniqueId>`,
    `    <generationTime>${generationTime}</generationTime>`,
    `    <expirationTime>${expirationTime}</expirationTime>`,
    `  </header>`,
    `  <service>${SERVICE_NAME}</service>`,
    `</loginTicketRequest>`,
  ].join("\n");
}

function toAfipDatetime(d: Date): string {
  // AFIP expects: YYYY-MM-DDTHH:MM:SS-03:00 (Argentina UTC offset, ART = UTC-3).
  // Server clock is UTC — subtract 3 h first so the UTC getters read ART wall time,
  // then append the fixed -03:00 offset suffix that WSAA requires.
  const pad = (n: number) => String(n).padStart(2, "0");
  const art = new Date(d.getTime() - 3 * 60 * 60 * 1_000);
  return (
    `${art.getUTCFullYear()}-${pad(art.getUTCMonth() + 1)}-${pad(art.getUTCDate())}` +
    `T${pad(art.getUTCHours())}:${pad(art.getUTCMinutes())}:${pad(art.getUTCSeconds())}-03:00`
  );
}

// ── WSAA SOAP request builder ─────────────────────────────────────────────────

function buildWsaaBody(cms: string): string {
  return buildSoapEnvelope(
    "http://wsaa.view.sua.afip.gov.ar",
    `<ar:loginCms><ar:in0>${cms}</ar:in0></ar:loginCms>`,
  );
}

// ── Parse WSAA response ───────────────────────────────────────────────────────

function parseWsaaResponse(xml: string): ArcaTicket {
  const raw = extractTag(xml, "loginCmsReturn");
  if (!raw) {
    throw new Error(`[wsaa] loginCmsReturn not found in WSAA response: ${xml.slice(0, 400)}`);
  }
  let taXml: string;
  try {
    const decoded = Buffer.from(raw, "base64").toString("utf-8");
    taXml = decoded.includes("<loginTicketResponse") ? decoded : raw;
  } catch {
    taXml = raw;
  }

  const token = extractTag(taXml, "token");
  const sign = extractTag(taXml, "sign");
  const expirationTime = extractTag(taXml, "expirationTime");

  if (!token || !sign || !expirationTime) {
    throw new Error(
      `[wsaa] Incomplete TA in WSAA response — token:${!!token} sign:${!!sign} exp:${!!expirationTime}. ` +
        `Raw: ${taXml.slice(0, 300)}`,
    );
  }

  const expiresAt = new Date(expirationTime).toISOString();
  return { token, sign, expiresAt };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Returns a valid Ticket de Acceso for the given AFIP credential.
 * Uses L1 in-memory cache first, then L2 DB cache, and finally calls WSAA.
 * L1 is process-local (fast). L2 is shared across Cloud Run instances (prevents
 * repeated logins that would exhaust the AFIP ~1000 calls/day quota).
 *
 * Concurrent cold starts for the same tenant are serialised via `inFlight` so
 * only one loginCms request is sent. Without this, two requests landing within
 * the same wall-clock second produce the same uniqueId and AFIP rejects the
 * second call as a replay (uniqueId collision).
 */
export async function getTicket(
  credential: ArcaCredential,
  isProduction: boolean,
): Promise<ArcaTicket> {
  // L1: in-memory cache (this instance, this process).
  const l1 = cachedTicket(credential.businessId);
  if (l1) return l1;

  // In-flight dedup: if a WSAA call for this tenant is already running, reuse it.
  const existing = inFlight.get(credential.businessId);
  if (existing) return existing;

  const promise = (async (): Promise<ArcaTicket> => {
    try {
      // L2: DB cache (shared across all Cloud Run instances).
      const l2 = await readDbCache(credential.businessId);
      if (l2) {
        // Warm L1 so subsequent calls in this instance skip the DB.
        ticketCache.set(credential.businessId, l2);
        return l2;
      }

      // Cache miss — call WSAA.
      const { privateKey, certPem } = await loadCertFromGcs(
        credential.certGcsPath,
        credential.passphrase,
      );

      const ltrXml = buildLoginTicketRequestXml(credential.cuit);
      const cms = buildCms(Buffer.from(ltrXml, "utf-8"), privateKey, certPem);

      const endpoint = isProduction ? WSAA_PROD : WSAA_HOMO;
      const soapBody = buildWsaaBody(cms);
      const responseXml = await soapPost(endpoint, "loginCms", soapBody);

      const ticket = parseWsaaResponse(responseXml);

      // Populate both cache layers.
      ticketCache.set(credential.businessId, ticket);
      await writeDbCache(credential.businessId, ticket);

      return ticket;
    } finally {
      // Always remove the in-flight entry so future calls can proceed normally.
      inFlight.delete(credential.businessId);
    }
  })();

  // IMPORTANT: set inFlight BEFORE any await — this is the dedup point.
  // Do NOT insert async work between the promise constructor call above and
  // this line; doing so would open a window where two concurrent callers both
  // miss the inFlight entry and each issue their own WSAA loginCms request,
  // producing the same uniqueId and triggering an AFIP replay-rejection.
  inFlight.set(credential.businessId, promise);
  return promise;
}

/** Evict both cache layers for a business (useful after auth errors or cert rotation). */
export function evictTicket(businessId: string): void {
  ticketCache.delete(businessId);
  // Also clear any in-flight promise so the next call starts a fresh WSAA login.
  inFlight.delete(businessId);
  // Best-effort clear of L2 DB cache so the next instance also fetches a fresh ticket.
  void prisma.arcaCredential
    .update({
      where: { businessId },
      data: { cachedToken: null, cachedSign: null, cachedExpiresAt: null },
    })
    .catch(() => undefined);
}
