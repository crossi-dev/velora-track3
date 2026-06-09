// GET /api/internal/agents/biz-snapshot?businessId=...
//
// Internal endpoint: returns business fields + mpConnection that the Payments
// Agent needs to build a BizSnapshot, replacing a direct Prisma read from the
// agent worker (Phase 2 S3 — agent-to-core HTTP, not direct DB).
//
// Auth: shared CRON_SECRET bearer token — same secret the whatsapp-inbound
// Cloud Tasks worker uses for its fallback path (src/app/api/internal/tasks/
// whatsapp-inbound/route.ts, line 45). The payments agent worker already has
// CRON_SECRET in its env (required by env.ts startup validation).
// Timing-safe comparison prevents constant-time oracle attacks.
//
// Why not OIDC here: the caller is the payments agent (not Cloud Tasks). There
// is no SA-pinned OIDC token available in that context. CRON_SECRET bearer is
// the correct internal-service-to-service mechanism already established.
//
// Allowlist: /api/internal/agents/biz-snapshot is added to API_ALLOWLIST in
// middleware.ts (explicit per-endpoint entry, same pattern as /api/internal/tasks
// and /api/internal/dlq) so middleware does not gate it with the session check
// before the handler runs.
//
// This is a read-only GET — no mutation contract, no rate limit (internal only,
// not user-facing). Structured { code, message } errors as per api-standards.

import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { cloudLog } from "@/lib/cloud-logger";

const EXPECTED_SECRET = process.env.CRON_SECRET ?? "";

function timingSafeEqualStr(a: string, b: string): boolean {
  try {
    return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
  } catch {
    return false;
  }
}

function verifyBearer(authHeader: string | null): boolean {
  if (!authHeader?.startsWith("Bearer ")) return false;
  if (!EXPECTED_SECRET) return false;
  return timingSafeEqualStr(authHeader.slice(7), EXPECTED_SECRET);
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (!verifyBearer(req.headers.get("authorization"))) {
    cloudLog({
      severity: "WARNING",
      component: "A2A",
      action: "BIZ_SNAPSHOT_AUTH_FAILED",
      a2a_transfer: false,
      message: "biz-snapshot: unauthorized request — bearer mismatch or missing",
    });
    return NextResponse.json(
      { code: "UNAUTHORIZED", message: "Authentication required." },
      { status: 401 },
    );
  }

  const businessId = new URL(req.url).searchParams.get("businessId");
  if (!businessId) {
    return NextResponse.json(
      { code: "BAD_REQUEST", message: "Missing required query param: businessId." },
      { status: 400 },
    );
  }

  try {
    const [biz, mpConn] = await Promise.all([
      prisma.business.findUnique({
        where: { id: businessId },
        select: {
          userId: true,
          name: true,
          paymentProvider: true,
          postalCode: true,
          alias: true,
          whatsappPhone: true,
          cuit: true,
          courierPreference: true,
        },
      }),
      prisma.mpConnection.findUnique({
        where: { businessId },
        select: {
          accessTokenCiphertext: true,
          expiresAt: true,
          scope: true,
        },
      }),
    ]);

    if (!biz) {
      return NextResponse.json(
        { code: "NOT_FOUND", message: "Business not found." },
        { status: 404 },
      );
    }

    return NextResponse.json({
      business: {
        userId: biz.userId,
        name: biz.name,
        paymentProvider: biz.paymentProvider,
        postalCode: biz.postalCode,
        alias: biz.alias,
        whatsappPhone: biz.whatsappPhone,
        cuit: biz.cuit,
        courierPreference: biz.courierPreference ?? null,
      },
      mpConnection: mpConn
        ? {
            accessTokenCiphertext: mpConn.accessTokenCiphertext,
            expiresAt: mpConn.expiresAt,
            scope: mpConn.scope,
          }
        : null,
    });
  } catch (err) {
    cloudLog({
      severity: "ERROR",
      component: "A2A",
      action: "BIZ_SNAPSHOT_DB_ERROR",
      a2a_transfer: false,
      message: "biz-snapshot: DB query threw",
      data: {
        businessId,
        errorName: err instanceof Error ? err.name : "NonError",
        errorMessage: err instanceof Error ? err.message : String(err),
      },
    });
    return NextResponse.json(
      { code: "INTERNAL_ERROR", message: "Failed to fetch business snapshot." },
      { status: 500 },
    );
  }
}
