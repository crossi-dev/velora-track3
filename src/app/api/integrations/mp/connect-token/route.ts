// POST /api/integrations/mp/connect-token — owner-only.
//
// Bring-your-own MP access token connect flow. Each merchant creates their
// own MP developer app, gets a Production access token (APP_USR-…), and
// pastes it here. Velora encrypts it and upserts MpConnection.
//
// This path bypasses the OAuth code→token exchange entirely and is the
// recommended path while Velora's OAuth client registration is pending.
// The existing OAuth flow (/connect → /callback) is preserved and still
// works independently. Both paths write to the same MpConnection row.
//
// Token expiry: MP's /users/me response may include an `expiration_date`
// (ISO-8601 string). When present we use it directly. Otherwise we default
// to 60 days — more conservative than the previous "1 year" assumption,
// since MP can revoke self-managed tokens at any time (typically 60–180 days).

import { NextRequest, NextResponse } from "next/server";
import {
  badRequest,
  bypassIfTester,
  checkRateLimit,
  conflict,
  internalError,
  logRouteError,
  parseJsonBody,
  unauthorized,
} from "@/app/api/_lib/route-helpers";
import { resolveActor, requireRole } from "@/app/api/_lib/resolve-actor";
import { getIdempotencyKey, beginIdempotentMutation, completeIdempotentMutation, releaseIdempotentMutation } from "@/app/api/_lib/idempotency";
import {
  getServerActionMeta,
  type RouteMutationDeclaration,
} from "@/app/api/_lib/mutation-contract";
import { prisma } from "@/lib/prisma";
import { connectMercadoPago } from "./_lib/mp-connect-core";

const MUTATION_ACTIONS = {
  POST: "mp_connection.connect_self_managed",
} as const satisfies RouteMutationDeclaration;
const ACTION_META = getServerActionMeta(MUTATION_ACTIONS.POST);

interface ConnectTokenBody {
  accessToken?: unknown;
  mpUserId?: unknown;
}

export async function POST(req: NextRequest) {
  void ACTION_META;

  // ── Auth: owner only ─────────────────────────────────────────────────────
  const ctx = await resolveActor(req);
  if (!ctx) return unauthorized();
  const roleGate = requireRole(ctx, ["owner"]);
  if (roleGate) return roleGate;

  // ── Rate limit ───────────────────────────────────────────────────────────
  const rateLimited = checkRateLimit(req, undefined, undefined, undefined, bypassIfTester(ctx));
  if (rateLimited) return rateLimited;

  // ── Parse body ───────────────────────────────────────────────────────────
  const parsed = await parseJsonBody<ConnectTokenBody>(req);
  if (!parsed.ok) return parsed.response;

  const { accessToken: rawToken } = parsed.data;

  if (typeof rawToken !== "string" || !rawToken.startsWith("APP_USR-") || rawToken.length < 20) {
    return badRequest(
      "El access token debe empezar con APP_USR- y ser un token de Producción válido.",
    );
  }
  const accessToken = rawToken.trim();

  // ── Idempotency ──────────────────────────────────────────────────────────
  const idempotencyKey = getIdempotencyKey(req);
  const idempotency = await beginIdempotentMutation({
    client: prisma,
    businessId: ctx.businessId,
    actionType: MUTATION_ACTIONS.POST,
    idempotencyKey,
    requestBody: { accessToken: accessToken.slice(0, 16) }, // prefix only — never log plaintext
    req,
  });

  if (idempotency.kind === "missing") return idempotency.response;
  if (idempotency.kind === "conflict") return conflict("Conflicto de idempotencia.");
  if (idempotency.kind === "in_flight") return conflict("Operación en curso.");
  if (idempotency.kind === "replay") return idempotency.response;

  const { recordId } = idempotency;

  try {
    // ── Validate + encrypt + upsert + audit (shared with MCP tool) ─────────
    const result = await connectMercadoPago({
      businessId: ctx.businessId,
      actorUserId: ctx.actorUserId,
      accessToken,
    });

    if (!result.ok) {
      await releaseIdempotentMutation({ client: prisma, recordId });
      return badRequest(result.message);
    }

    const responseBody = { ok: true, mpUserId: result.mpUserId };
    await completeIdempotentMutation({
      client: prisma,
      recordId,
      responseStatus: 200,
      responseBody,
    });
    return NextResponse.json(responseBody);
  } catch (error) {
    await releaseIdempotentMutation({ client: prisma, recordId });
    logRouteError("integrations/mp/connect-token", error);
    return internalError("No se pudo guardar la conexión. Reintentá.");
  }
}
