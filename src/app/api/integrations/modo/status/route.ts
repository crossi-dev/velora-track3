// GET /api/integrations/modo/status — owner-only.
//
// Returns { connected: boolean } — NEVER returns credential plaintext.
// The frontend uses this to decide which state to render in SettingsModoCard.

import { NextRequest, NextResponse } from "next/server";
import {
  bypassIfTester,
  checkRateLimit,
  jsonError,
  internalError,
  logRouteError,
} from "@/app/api/_lib/route-helpers";
import { resolveActor, requireRole } from "@/app/api/_lib/resolve-actor";
import { prisma } from "@/lib/prisma";

export async function GET(req: NextRequest) {
  // ── Auth: owner only ─────────────────────────────────────────────────────
  const ctx = await resolveActor(req);
  if (!ctx) {
    return jsonError("UNAUTHORIZED", "Authentication required.", 401);
  }

  // ── Rate limit ───────────────────────────────────────────────────────────
  const rateLimited = checkRateLimit(req, undefined, undefined, undefined, bypassIfTester(ctx));
  if (rateLimited) return rateLimited;
  const roleGate = requireRole(ctx, ["owner"]);
  if (roleGate) return roleGate;

  // ── Query ────────────────────────────────────────────────────────────────
  try {
    const row = await prisma.modoConnection.findUnique({
      where: { businessId: ctx.businessId },
      select: { id: true }, // Only existence check — never return credential data.
    });
    return NextResponse.json({ connected: row !== null });
  } catch (err) {
    logRouteError("integrations/modo/status", err);
    return internalError("No se pudo leer el estado de MODO.");
  }
}
