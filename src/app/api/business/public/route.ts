import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/app/api/_lib/route-helpers";
import { cloudLog } from "@/lib/cloud-logger";

// SEC-NOTE: This endpoint is intentionally unauthenticated and returns only
// the business name given a businessId. It acts as a name-lookup oracle so
// the employee login screen can display the business name before the employee
// authenticates. The only data exposed is the business name (non-sensitive).
// The rate limit (10/60s) and timing-safe 404 limit enumeration risk.
const NOT_FOUND = NextResponse.json({ code: "not_found" }, { status: 404 });

export async function GET(req: NextRequest) {
  const rateLimited = checkRateLimit(req, "business-public", 10, 60);
  if (rateLimited) return rateLimited;

  const id = req.nextUrl.searchParams.get("b");
  if (!id || typeof id !== "string" || id.length > 60) {
    await new Promise((r) => setTimeout(r, 50));
    cloudLog({ severity: "INFO", component: "System", action: "UNAUTH_LOOKUP", a2a_transfer: false, message: "public lookup — missing param", businessId: "", data: { found: false, slugPreview: "" } });
    return NOT_FOUND;
  }

  const biz = await prisma.business.findUnique({ where: { id }, select: { name: true } }).catch(() => null);
  cloudLog({ severity: "INFO", component: "System", action: "UNAUTH_LOOKUP", a2a_transfer: false, message: "public lookup", businessId: id, data: { found: !!biz, slugPreview: id.slice(0, 4) } });

  if (!biz) {
    await new Promise((r) => setTimeout(r, 50));
    return NOT_FOUND;
  }
  return NextResponse.json({ name: biz.name });
}
