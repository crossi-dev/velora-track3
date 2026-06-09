// GET /api/integrations/mp/status — owner-only.
// La UI de Ajustes lee este endpoint para decidir qué pill / botón mostrar.

import { NextRequest, NextResponse } from "next/server";
import {
  checkRateLimit,
  bypassIfTester,
  internalError,
  logRouteError,
  unauthorized,
} from "@/app/api/_lib/route-helpers";
import { resolveActor, requireRole } from "@/app/api/_lib/resolve-actor";
import { prisma } from "@/lib/prisma";
import { getMpConfig } from "../_lib/config";

export async function GET(req: NextRequest) {
  const ctx = await resolveActor(req);
  if (!ctx) return unauthorized();
  const roleGate = requireRole(ctx, ["owner"]);
  if (roleGate) return roleGate;

  // Status endpoint is polled by the Settings card on mount + after every
  // connect/disconnect — tester bypass essential to avoid 429 loops during testing.
  const rateLimited = checkRateLimit(req, undefined, undefined, undefined, bypassIfTester(ctx));
  if (rateLimited) return rateLimited;

  const cfg = getMpConfig();
  if (!cfg.isConfigured) {
    return NextResponse.json(
      { configured: false, connected: false },
      { status: 200 },
    );
  }

  try {
    const conn = await prisma.mpConnection.findUnique({
      where: { businessId: ctx.businessId },
      select: { mpUserId: true, expiresAt: true, liveMode: true, externalPosId: true },
    });
    if (!conn) {
      return NextResponse.json(
        { configured: true, connected: false },
        { status: 200 },
      );
    }
    return NextResponse.json(
      {
        configured: true,
        connected: true,
        mpUserId: conn.mpUserId,
        expiresAt: conn.expiresAt.toISOString(),
        liveMode: conn.liveMode,
        // posProvisioned: true when externalPosId has been set (QR cobro ready).
        // false means provisioning is still pending — QR cobro will fail at runtime.
        posProvisioned: conn.externalPosId !== null,
      },
      { status: 200 },
    );
  } catch (error) {
    logRouteError("integrations/mp/status", error);
    return internalError("No se pudo leer el estado de Mercado Pago.");
  }
}
