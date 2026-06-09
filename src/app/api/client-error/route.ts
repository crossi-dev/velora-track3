import { NextRequest, NextResponse } from "next/server";
import { reportError } from "@/lib/cloud-logger";
import { checkRateLimit } from "@/app/api/_lib/route-helpers";

const MAX_MESSAGE_LEN = 300;
const MAX_BODY_BYTES = 1024;

// Allowed scope values — closed set prevents log injection via the scope field.
const ALLOWED_SCOPES = new Set(["error-boundary", "crash-reporter", "hydration-error"]);

export async function POST(req: NextRequest): Promise<NextResponse> {
  // Rate-limit: 10 reports per minute per IP — prevents log-flooding attacks.
  // NOTE: no tester bypass — this endpoint has no auth/actor resolution by design
  // (it's a crash reporter that fires even when the session is broken). The 10/min
  // cap is unlikely to be an issue during testing; raise the limit here if needed.
  const rl = checkRateLimit(req, "client-error", 10, 60);
  if (rl) return rl;

  try {
    const raw = await req.text();
    if (raw.length > MAX_BODY_BYTES) return new NextResponse(null, { status: 413 });

    const body = JSON.parse(raw) as { message?: string; digest?: string; scope?: string };

    // Truncate and strip control characters to prevent log injection.
    const rawMessage = typeof body.message === "string" ? body.message : "Client-side error";
    // eslint-disable-next-line no-control-regex -- intentionally strips control characters
    const message = rawMessage.slice(0, MAX_MESSAGE_LEN).replace(/[\x00-\x1f\x7f]/g, " ").trim();

    // Scope is validated against an allowlist — never log raw user-supplied scope.
    const rawScope = typeof body.scope === "string" ? body.scope : "error-boundary";
    const scope = ALLOWED_SCOPES.has(rawScope) ? rawScope : "error-boundary";

    // digest is a Next.js error digest — format is a short alphanumeric hash.
    const rawDigest = typeof body.digest === "string" ? body.digest : null;
    const digest = rawDigest ? rawDigest.replace(/[^a-zA-Z0-9\-_]/g, "").slice(0, 64) : null;

    const meta = digest ? { scope, digest } : { scope };
    reportError(new Error(message), meta);
  } catch {
    // Ignore malformed payloads — never break the reporter itself.
  }
  return new NextResponse(null, { status: 204 });
}
