// IP allowlist + in-memory LRU fallback helpers for webhook-security.ts.
// Extracted to keep webhook-security.ts under the 300-line server/api contract.

// ── MP CIDR allowlist ─────────────────────────────────────────────────────────
// Set MP_TRUSTED_CIDRS=cidr1,cidr2 in Cloud Run env to skip the IP ban for known
// MP egress IPs. Parsed once at cold start; empty = no allowlist (safe default).
const _MP_CIDR_RAW = process.env.MP_TRUSTED_CIDRS ?? "";
const _MP_CIDRS: { n: bigint; m: bigint }[] = parseCidrs(_MP_CIDR_RAW);

function parseCidrs(raw: string): { n: bigint; m: bigint }[] {
  if (!raw.trim()) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .flatMap((cidr) => {
      const [ip, b] = cidr.split("/");
      const bits = parseInt(b ?? "32", 10);
      if (!ip || Number.isNaN(bits) || bits < 0 || bits > 32) return [];
      const p = ip.split(".").map(Number);
      if (p.length !== 4 || p.some((x) => Number.isNaN(x) || x < 0 || x > 255)) return [];
      const ni = BigInt(((p[0]! << 24) | (p[1]! << 16) | (p[2]! << 8) | p[3]!) >>> 0);
      const mi = bits === 0 ? 0n : BigInt(0xffffffff) << BigInt(32 - bits);
      return [{ n: ni & mi, m: mi }];
    });
}

export function isMpTrustedIp(ip: string): boolean {
  if (_MP_CIDRS.length === 0) return false;
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((x) => Number.isNaN(x) || x < 0 || x > 255)) return false;
  const ni = BigInt(((p[0]! << 24) | (p[1]! << 16) | (p[2]! << 8) | p[3]!) >>> 0);
  return _MP_CIDRS.some(({ n, m }) => (ni & m) === n);
}

// ── In-memory LRU ban fallback ────────────────────────────────────────────────
// Used when DB is unreachable. Per-instance (not fleet-wide) but better than
// fully fail-open under a sustained DB outage + flood attack.
const MEM_BAN_MAX = 1_000;
const _memMap = new Map<string, { count: number; bannedUntil: number; lastSeen: number }>();

export function memBanRecord(ip: string, nowMs: number, threshold: number, banDurationMs: number): void {
  if (_memMap.size >= MEM_BAN_MAX) {
    let ok = "";
    let ot = Infinity;
    for (const [k, v] of _memMap) {
      if (v.lastSeen < ot) { ot = v.lastSeen; ok = k; }
    }
    if (ok) _memMap.delete(ok);
  }
  const e = _memMap.get(ip);
  const count = (e?.count ?? 0) + 1;
  const bannedUntil = count >= threshold ? nowMs + banDurationMs : (e?.bannedUntil ?? 0);
  _memMap.set(ip, { count, bannedUntil, lastSeen: nowMs });
}

export function memBanCheck(ip: string, nowMs: number): boolean {
  const e = _memMap.get(ip);
  return !!e && e.bannedUntil > nowMs;
}
