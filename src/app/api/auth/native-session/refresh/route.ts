// POST /api/auth/native-session/refresh
//
// Exchange a still-valid owner native token for a fresh one (24h TTL reset).
// Stateless sliding-window refresh: no DB write, just re-sign. (C2)
//
// Rate limited to 10 req/60s per IP — same as the initial session endpoint.
// Allowlisted in middleware (covered by /api/auth prefix).

import { NextRequest } from "next/server";
import {
  OWNER_NATIVE_HEADER,
  verifyOwnerNativeToken,
  signOwnerNativeTokenEdge,
} from "@/lib/owner-native-auth-edge";
import { cloudLog } from "@/lib/cloud-logger";
import { checkRateLimit, jsonError } from "@/app/api/_lib/route-helpers";

export async function POST(req: NextRequest) {
  const rateLimit = checkRateLimit(req, "native-session-refresh", 10, 60);
  if (rateLimit) return rateLimit;

  const token = req.headers.get(OWNER_NATIVE_HEADER);
  const result = await verifyOwnerNativeToken(token);

  if (!result) {
    return jsonError("UNAUTHORIZED", "Invalid or expired native token.", 401);
  }

  const { userId, email } = result.payload;

  const fresh = await signOwnerNativeTokenEdge({ userId, email });

  cloudLog({
    severity: "INFO",
    component: "System",
    action: "NATIVE_SESSION_REFRESHED",
    a2a_transfer: false,
    message: "Native session token refreshed",
    businessId: "",
    data: {
      email,
      userId,
      ip: req.headers.get("x-forwarded-for") ?? "unknown",
      ua: req.headers.get("user-agent") ?? "unknown",
    },
  });

  return Response.json({ token: fresh });
}
