// POST /api/auth/invalidate-all-sessions
//
// Increments the caller's sessionVersion, immediately invalidating all
// existing JWTs for their account (including the one making this request).
// The browser session that called this endpoint will be signed out on the
// next authenticated request.
//
// Only the authenticated owner can call this — it operates on their own
// userId only. There is no admin variant that targets other users.

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { invalidateUserSession } from "@/lib/auth-session-version";
import { checkRateLimit, jsonError } from "@/app/api/_lib/route-helpers";
import { cloudLog } from "@/lib/cloud-logger";

export async function POST(req: NextRequest) {
  const rateLimit = checkRateLimit(req, "invalidate-sessions", 5, 60);
  if (rateLimit) return rateLimit;

  const session = await auth();
  if (!session?.user?.id) {
    return jsonError("UNAUTHORIZED", "Not authenticated", 401);
  }

  const userId = session.user.id;

  await invalidateUserSession(userId);

  cloudLog({
    severity: "INFO",
    component: "System",
    action: "AUTH_ALL_SESSIONS_INVALIDATED",
    a2a_transfer: false,
    message: "User requested invalidation of all sessions",
    businessId: "",
    data: { userId },
  });

  return NextResponse.json({ ok: true, message: "All sessions invalidated. You will be signed out shortly." });
}
