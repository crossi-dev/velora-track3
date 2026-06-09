// POST /api/employee-notes/ack — marca una nota de empleado como leída por el dueño.

import { NextRequest, NextResponse } from "next/server";
import { resolveActor, requireRole } from "@/app/api/_lib/resolve-actor";
import { checkRateLimit, bypassIfTester } from "@/app/api/_lib/route-helpers";
import { acknowledgeNote } from "@/app/api/business-assistant/_lib/employee-note-handler";

export async function POST(req: NextRequest) {
  const ctx = await resolveActor(req);
  if (!ctx) {
    return NextResponse.json({ code: "UNAUTHORIZED", message: "Authentication required." }, { status: 401 });
  }
  const forbidden = requireRole(ctx, ["owner"]);
  if (forbidden) return forbidden;

  const rateLimited = checkRateLimit(req, undefined, undefined, undefined, bypassIfTester(ctx));
  if (rateLimited) return rateLimited;

  const body = (await req.json()) as { noteId?: unknown };
  if (typeof body.noteId !== "string" || !body.noteId) {
    return NextResponse.json({ error: "noteId required" }, { status: 400 });
  }

  await acknowledgeNote(body.noteId, ctx.businessId);
  return NextResponse.json({ ok: true });
}
