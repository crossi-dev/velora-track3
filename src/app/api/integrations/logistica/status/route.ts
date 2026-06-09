// GET /api/integrations/logistica/status — owner-only.
//
// Returns which courier providers are connected for this business.
// Response:
//   {
//     andreani: { connected: boolean },
//     oca:      { connected: boolean },
//     correo:   { connected: boolean },
//   }
//
// Security: credentials (encryptedCredentials) are NEVER returned.
// Only the presence of a row is reported.

import { NextRequest, NextResponse } from "next/server";
import {
  bypassIfTester,
  checkRateLimit,
  jsonError,
  logRouteError,
} from "@/app/api/_lib/route-helpers";
import { resolveActor, requireRole } from "@/app/api/_lib/resolve-actor";
import { prisma } from "@/lib/prisma";

const PROVIDERS = ["andreani", "oca", "correo"] as const;
type Provider = (typeof PROVIDERS)[number];

export async function GET(req: NextRequest) {
  const ctx = await resolveActor(req);
  if (!ctx) {
    return jsonError("UNAUTHORIZED", "Authentication required.", 401);
  }

  const rateLimited = checkRateLimit(req, "logistica-status", undefined, undefined, bypassIfTester(ctx));
  if (rateLimited) return rateLimited;
  const roleGate = requireRole(ctx, ["owner"]);
  if (roleGate) return roleGate;

  try {
    const rows = await prisma.courierCredential.findMany({
      where:  { businessId: ctx.businessId },
      select: { provider: true },
    });

    const connected = new Set(rows.map((r) => r.provider));
    const result: Record<Provider, { connected: boolean }> = {
      andreani: { connected: connected.has("andreani") },
      oca:      { connected: connected.has("oca") },
      correo:   { connected: connected.has("correo") },
    };

    return NextResponse.json(result);
  } catch (err) {
    logRouteError("integrations/logistica/status", err);
    // Fail open — assume not connected; owner can retry.
    return NextResponse.json({
      andreani: { connected: false },
      oca:      { connected: false },
      correo:   { connected: false },
    });
  }
}
