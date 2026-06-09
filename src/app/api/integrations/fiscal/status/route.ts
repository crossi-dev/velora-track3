// GET /api/integrations/fiscal/status — owner-only.
//
// Returns whether an ArcaCredential exists for the business,
// plus the safe displayable fields the Settings UI card needs.
//
// Response:
//   { connected: false }
//   { connected: true, cuit: string, ivaCondition: string | null, puntoVenta: number, environment: string }
//
// The passphrase, raw cert, and GCS object key are NEVER returned.

import { NextRequest, NextResponse } from "next/server";
import {
  bypassIfTester,
  checkRateLimit,
  jsonError,
  logRouteError,
} from "@/app/api/_lib/route-helpers";
import { resolveActor, requireRole } from "@/app/api/_lib/resolve-actor";
import { prisma } from "@/lib/prisma";

export type FiscalStatusResponse =
  | { connected: false }
  | {
      connected: true;
      cuit: string;
      ivaCondition: string | null;
      puntoVenta: number;
      environment: string;
    };

export async function GET(req: NextRequest) {
  const ctx = await resolveActor(req);
  if (!ctx) {
    return jsonError("UNAUTHORIZED", "Authentication required.", 401);
  }

  const rateLimited = checkRateLimit(req, "fiscal-status", undefined, undefined, bypassIfTester(ctx));
  if (rateLimited) return rateLimited;
  const roleGate = requireRole(ctx, ["owner"]);
  if (roleGate) return roleGate;

  try {
    const credential = await prisma.arcaCredential.findUnique({
      where: { businessId: ctx.businessId },
      select: {
        cuit: true,
        condicionIva: true,
        puntoVenta: true,
        environment: true,
      },
    });

    if (!credential) {
      return NextResponse.json<FiscalStatusResponse>({ connected: false });
    }

    return NextResponse.json<FiscalStatusResponse>({
      connected: true,
      cuit: credential.cuit,
      ivaCondition: credential.condicionIva || null,
      puntoVenta: credential.puntoVenta,
      environment: credential.environment,
    });
  } catch (err) {
    logRouteError("integrations/fiscal/status", err);
    return NextResponse.json<FiscalStatusResponse>({ connected: false });
  }
}
