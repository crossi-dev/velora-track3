import { prisma } from "@/lib/prisma";
import { cloudLog } from "@/lib/cloud-logger";
import { consumeToken } from "./rate-limit-token-bucket";
import { getArgentinaDayStart } from "@/lib/argentina-date";

// Production limits for 100-business scale (2026-05-14).
// Owner:   20 LLM calls/min (Fast Path hits don't count — only LLM Slow Path)
// Employee: 10 LLM calls/min (Flash, cheaper but still metered)
// Daily: 500/user (owner) — enough headroom for a full business day
//
// These are per-actor (userId) limits. Business-level caps live in checkRateLimit.
// See project_rate_limits_relaunch.md — switching from dev values (10/min, 100/day).
const AI_DAILY_LIMIT = 500;

// Per-minute LLM burst cap — Postgres token bucket (multi-instance safe).
// Previous implementation used an in-process Map; with N Cloud Run instances
// the effective global cap silently multiplied to limit × N.
// Now routes through RateLimitBucket (same atomic CTE pattern as rate-limit-core.ts).
// Fail-open on DB error: rate limiting is a fairness layer, not a security gate.
// The daily cap (checkAiRateLimit below) remains the hard outer gate.
const AI_PER_MINUTE_LIMIT = 20; // restored to intended global cap (was 5 to compensate for in-memory multi-instance)
const MINUTE_WINDOW_S = 60;

// Master switch — opt-out, default ON. Cuando RATE_LIMIT_ENABLED=false ambos
// chequeos retornan true sin tocar DB ni mapa. Pensado para dev/test sin
// fricción; flip a true (o sin setear) antes de cualquier lanzamiento público.
// Ver memory project_rate_limits_relaunch.md.
function isRateLimitEnabled(): boolean {
  return process.env.RATE_LIMIT_ENABLED !== "false";
}

// AI rate limits are NEVER bypassed for tester accounts.
// Tester bypass (bypassIfTester) only applies to non-LLM per-minute/per-IP
// limits (checkRateLimitCore). Gemini usage is metered by Google and carries
// real cost; bypassing it for testers creates an unbounded Vertex spend vector.
// Security finding auth-M1 (2026-05-30): removed bypass param from both functions.
export async function checkAiPerMinuteLimit(userId: string): Promise<boolean> {
  if (!isRateLimitEnabled()) return true;
  // Token bucket key is scoped to the per-minute window; refillRate = capacity / windowSeconds.
  const result = await consumeToken(`ai:permin:${userId}`, {
    capacity: AI_PER_MINUTE_LIMIT,
    refillRate: AI_PER_MINUTE_LIMIT / MINUTE_WINDOW_S,
  });
  return result.allowed;
}

// Returns the start of the current calendar day in ART as a Date for DB comparison.
// Delegates to getArgentinaDayStart (Intl-based, DST-safe) from @/lib/argentina-date.
function getArtDayStart(): Date {
  return new Date(getArgentinaDayStart());
}

export async function checkAiRateLimit(userId: string): Promise<boolean> {
  if (!isRateLimitEnabled()) return true;
  const today = getArtDayStart();

  // Atomic conditional UPDATE: only increments if row exists AND count < limit.
  // Affected rows = 1 → under limit, done. Affected rows = 0 → row missing or
  // limit already reached; disambiguate with a CREATE attempt.
  const updated = await prisma.aiRateLimit.updateMany({
    where: { userId, date: today, count: { lt: AI_DAILY_LIMIT } },
    data: { count: { increment: 1 } },
  });

  if (updated.count === 1) return true;

  // Row didn't exist yet (first call today) — try to create it.
  try {
    await prisma.aiRateLimit.create({ data: { userId, date: today, count: 1 } });
    return true;
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    if (code === "P2002") {
      // Row was created concurrently between our updateMany and our create attempt.
      // The concurrent request set count=1; our updateMany missed it (row didn't
      // exist yet). Retry the conditional increment now that the row exists.
      const retried = await prisma.aiRateLimit.updateMany({
        where: { userId, date: today, count: { lt: AI_DAILY_LIMIT } },
        data: { count: { increment: 1 } },
      });
      return retried.count === 1;
    }
    // Unexpected DB error — surface it instead of silently allowing/denying.
    cloudLog({ severity: "ERROR", component: "System", action: "AI_RATE_LIMIT_ERROR", a2a_transfer: false, message: "ai-rate-limit create failed unexpectedly", data: { userId, error: err instanceof Error ? err.message : String(err) } });
    throw err;
  }
}
