// POST /api/peers/call — invoke a skill on a trusted external A2A peer.
//
// Called by the Supervisor when it detects an external_agent_call intent.
// Owner-only: employees cannot initiate external A2A calls.
//
// Body: { domain, skillId, params }
// Response: { ok, text, data, agentName } or { error }

import { NextRequest, NextResponse } from "next/server";
import { runWithTraceContext } from "@/lib/cloud-logger";
import {
  checkRateLimit,
  internalError,
  logRouteError,
  unauthorized,
} from "@/app/api/_lib/route-helpers";
import { resolveActor, requireRole } from "@/app/api/_lib/resolve-actor";
import { callExternalAgent, ExternalAgentCallSchema } from "@/app/api/business-assistant/_lib/handlers/external-agent-call";

export async function POST(req: NextRequest) {
  return runWithTraceContext(req.headers, () => handlePost(req));
}

async function handlePost(req: NextRequest) {
  const rateLimited = checkRateLimit(req);
  if (rateLimited) return rateLimited;

  const ctx = await resolveActor(req);
  if (!ctx) return unauthorized();
  const roleGate = requireRole(ctx, ["owner"]);
  if (roleGate) return roleGate;

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  const parsed = ExternalAgentCallSchema.safeParse({
    ...(rawBody as object),
    businessId: ctx.businessId,
  });

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Parámetros inválidos", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const result = await callExternalAgent(parsed.data);
    if (!result.ok) {
      return NextResponse.json({ error: result.reason }, { status: 422 });
    }
    return NextResponse.json({
      ok: true,
      agentName: result.agentName,
      skillId: result.skillId,
      text: result.text,
      data: result.data,
    });
  } catch (error) {
    logRouteError("peers/call POST", error);
    return internalError("Error al llamar al agente externo.");
  }
}
