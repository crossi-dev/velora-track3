// GET /api/integrations/comunicaciones/status — owner-only.
//
// Returns which communication channel providers are connected for this business.
// Response:
//   {
//     twilio_sms: { connected: boolean },
//     resend:     { connected: boolean },
//     pedidosya:  { connected: boolean },
//   }
//
// Security: credentials (encryptedCredentials) are NEVER returned.
// Only the presence of a row per provider is reported.

import { NextRequest, NextResponse } from "next/server";
import {
  bypassIfTester,
  checkRateLimit,
  jsonError,
  logRouteError,
} from "@/app/api/_lib/route-helpers";
import { resolveActor, requireRole } from "@/app/api/_lib/resolve-actor";
import { prisma } from "@/lib/prisma";

const PROVIDERS = ["twilio_sms", "resend", "pedidosya"] as const;
type Provider = (typeof PROVIDERS)[number];

export async function GET(req: NextRequest) {
  const ctx = await resolveActor(req);
  if (!ctx) {
    return jsonError("UNAUTHORIZED", "Authentication required.", 401);
  }

  const rateLimited = checkRateLimit(
    req,
    "comunicaciones-status",
    undefined,
    undefined,
    bypassIfTester(ctx),
  );
  if (rateLimited) return rateLimited;
  const roleGate = requireRole(ctx, ["owner"]);
  if (roleGate) return roleGate;

  try {
    const rows = await prisma.businessChannelCredential.findMany({
      where:  { businessId: ctx.businessId },
      select: { provider: true },
    });

    const connected = new Set(rows.map((r) => r.provider));
    const result: Record<Provider, { connected: boolean }> = {
      twilio_sms: { connected: connected.has("twilio_sms") },
      resend:     { connected: connected.has("resend") },
      pedidosya:  { connected: connected.has("pedidosya") },
    };

    return NextResponse.json(result);
  } catch (err) {
    logRouteError("integrations/comunicaciones/status", err);
    // Fail open — assume not connected; owner can retry.
    return NextResponse.json({
      twilio_sms: { connected: false },
      resend:     { connected: false },
      pedidosya:  { connected: false },
    });
  }
}
