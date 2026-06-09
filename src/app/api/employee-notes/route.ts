// GET  /api/employee-notes          — lista notas pendientes del negocio (owner only)

import { NextRequest, NextResponse } from "next/server";
import { resolveActor, requireRole } from "@/app/api/_lib/resolve-actor";
import { checkRateLimit, bypassIfTester } from "@/app/api/_lib/route-helpers";
import { listPendingNotes } from "@/app/api/business-assistant/_lib/employee-note-handler";

export async function GET(req: NextRequest) {
  const ctx = await resolveActor(req);
  if (!ctx) {
    return NextResponse.json({ code: "UNAUTHORIZED", message: "Authentication required." }, { status: 401 });
  }
  const forbidden = requireRole(ctx, ["owner"]);
  if (forbidden) return forbidden;

  const rateLimited = checkRateLimit(req, undefined, undefined, undefined, bypassIfTester(ctx));
  if (rateLimited) return rateLimited;

  const notes = await listPendingNotes(ctx.businessId);
  return NextResponse.json({ notes });
}
