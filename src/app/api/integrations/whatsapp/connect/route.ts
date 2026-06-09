// POST /api/integrations/whatsapp/connect  — owner-only.
// DELETE /api/integrations/whatsapp/connect — owner-only.
//
// POST: exchange the Embedded Signup callback code for a Business Integration
//   System User (BISU) token, encrypt it (AES-256-GCM, mp-token-cipher), and
//   upsert WabaConnection for the owner's business.
//
//   Body: { code: string, wabaId: string, phoneNumberId: string }
//
//   Returns:
//     200 { ok: true, wabaId, phoneNumberId }
//     400 BAD_REQUEST — missing fields
//     503 WHATSAPP_NOT_CONFIGURED — WHATSAPP_APP_ID / WHATSAPP_APP_SECRET unset
//     502 WABA_TOKEN_EXCHANGE_FAILED — Meta returned an error
//
// DELETE: remove the owner's WabaConnection row (disconnect).
//
//   Returns:
//     200 { ok: true, wabaId }    — disconnected
//     200 { ok: true, wabaId: null } — was not connected (idempotent)
//
// Sources:
//   Meta Embedded Signup code exchange:
//     https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-customers-as-a-tech-provider#step-3--exchange-code-for-a-business-integration-system-user-access-token

import { NextRequest, NextResponse } from "next/server";
import {
  badRequest,
  bypassIfTester,
  checkRateLimit,
  internalError,
  jsonError,
  logRouteError,
  unauthorized,
} from "@/app/api/_lib/route-helpers";
import { resolveActor, requireRole } from "@/app/api/_lib/resolve-actor";
import {
  getServerActionMeta,
  type RouteMutationDeclaration,
} from "@/app/api/_lib/mutation-contract";
import { connectWabaUseCase, disconnectWabaUseCase } from "../_lib/connect-use-case";

const MUTATION_ACTIONS = {
  POST: "waba_connection.connect",
  DELETE: "waba_connection.disconnect",
} as const satisfies RouteMutationDeclaration;
// Metadata bindings — routeScope/actionType used in connect-use-case.ts via
// getServerActionMeta(). Bindings declared here for guardrail compliance.
const POST_META = getServerActionMeta(MUTATION_ACTIONS.POST);
const DELETE_META = getServerActionMeta(MUTATION_ACTIONS.DELETE);
void POST_META;
void DELETE_META;

export async function POST(req: NextRequest) {
  const ctx = await resolveActor(req);
  if (!ctx) return unauthorized();
  const roleGate = requireRole(ctx, ["owner"]);
  if (roleGate) return roleGate;

  const rateLimited = checkRateLimit(req, undefined, undefined, undefined, bypassIfTester(ctx));
  if (rateLimited) return rateLimited;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badRequest("Invalid JSON body.");
  }
  if (
    typeof body !== "object" ||
    body === null ||
    typeof (body as Record<string, unknown>).code !== "string" ||
    typeof (body as Record<string, unknown>).wabaId !== "string" ||
    typeof (body as Record<string, unknown>).phoneNumberId !== "string"
  ) {
    return badRequest("Required fields: code (string), wabaId (string), phoneNumberId (string).");
  }
  const { code, wabaId, phoneNumberId } = body as {
    code: string;
    wabaId: string;
    phoneNumberId: string;
  };

  try {
    const result = await connectWabaUseCase({
      businessId: ctx.businessId,
      actorUserId: ctx.actorUserId,
      actorEmployeeId: ctx.actorEmployeeId,
      code,
      wabaId,
      phoneNumberId,
    });

    if (result.outcome === "not_configured") {
      return jsonError(
        "WHATSAPP_NOT_CONFIGURED",
        "WHATSAPP_APP_ID and WHATSAPP_APP_SECRET are not configured. " +
          "Provision the Meta App and add credentials to Secret Manager.",
        503,
      );
    }
    if (result.outcome === "token_exchange_failed") {
      return jsonError("WABA_TOKEN_EXCHANGE_FAILED", result.error, 502);
    }
    return NextResponse.json(
      { ok: true, wabaId: result.wabaId, phoneNumberId: result.phoneNumberId },
      { status: 200 },
    );
  } catch (error) {
    logRouteError("integrations/whatsapp/connect POST", error);
    return internalError("No se pudo conectar WhatsApp Business.");
  }
}

export async function DELETE(req: NextRequest) {
  const ctx = await resolveActor(req);
  if (!ctx) return unauthorized();
  const roleGate = requireRole(ctx, ["owner"]);
  if (roleGate) return roleGate;

  const rateLimited = checkRateLimit(req, undefined, undefined, undefined, bypassIfTester(ctx));
  if (rateLimited) return rateLimited;

  try {
    const result = await disconnectWabaUseCase({
      businessId: ctx.businessId,
      actorUserId: ctx.actorUserId,
      actorEmployeeId: ctx.actorEmployeeId,
    });

    return NextResponse.json(
      {
        ok: true,
        wabaId: result.outcome === "disconnected" ? result.wabaId : null,
      },
      { status: 200 },
    );
  } catch (error) {
    logRouteError("integrations/whatsapp/connect DELETE", error);
    return internalError("No se pudo desconectar WhatsApp Business.");
  }
}
