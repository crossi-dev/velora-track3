import { NextRequest, NextResponse } from "next/server";
import { parseCuit, describePersonType } from "@/lib/cuit";
import { bypassIfTester, checkRateLimit, unauthorized, badRequest } from "@/app/api/_lib/route-helpers";
import { resolveActor, requireRole } from "@/app/api/_lib/resolve-actor";

export async function GET(req: NextRequest) {
  const ctx = await resolveActor(req);
  if (!ctx) return unauthorized();
  const forbidden = requireRole(ctx, ["owner"]);
  if (forbidden) return forbidden;

  const rateLimited = checkRateLimit(req, undefined, undefined, undefined, bypassIfTester(ctx));
  if (rateLimited) return rateLimited;

  const raw = req.nextUrl.searchParams.get("cuit") ?? "";
  if (!raw.trim()) return badRequest("Falta el CUIT.");

  const result = parseCuit(raw);

  if (!result.valid) {
    return NextResponse.json({
      valid: false,
      error: result.error ?? "CUIT inválido.",
      normalized: result.normalized,
    });
  }

  return NextResponse.json({
    valid: true,
    formatted: result.formatted,
    normalized: result.normalized,
    prefix: result.prefix,
    personType: result.personType,
    personTypeLabel: describePersonType(result.personType),
  });
}
