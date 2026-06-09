// Owner-only — lee AgentEventLog para visualizar el bus A2A en el dashboard.
// Sirve los datos crudos estructurados; el frontend formatea como pseudo-syslog.
//
// Diseño:
//   - GET sólo. Sin paginación — limit fijo a 100 últimos eventos.
//   - Filtro: businessId del owner. No se exponen rows de otros negocios.
//   - Payload se decodea defensivamente: si falla parse, se devuelve `null`.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { checkRateLimit, internalError, logRouteError, unauthorized } from "@/app/api/_lib/route-helpers";
import { resolveActor, requireRole } from "@/app/api/_lib/resolve-actor";

interface AgentEventRow {
  id: string;
  eventId: string;
  protocol: string;
  protocolVersion: string;
  eventType: string;
  source: string;
  destination: string;
  status: string;
  payload: unknown;
  decision: unknown;
  pushSent: number;
  errorMessage: string | null;
  createdAt: string;
  processedAt: string | null;
}

interface AgentEventsResponse {
  events: AgentEventRow[];
}

const LIMIT = 100;

function safeParseJson(raw: string | null | undefined): unknown {
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  const rateLimited = checkRateLimit(req);
  if (rateLimited) return rateLimited;

  const ctx = await resolveActor(req);
  if (!ctx) return unauthorized();
  const forbidden = requireRole(ctx, ["owner"]);
  if (forbidden) return forbidden;
  const { businessId } = ctx;

  try {
    const rows = await prisma.agentEventLog.findMany({
      where: {
        businessId,
        eventType: { notIn: ["CHAT_MESSAGE", "COMPANION_RESPONSE"] },
      },
      orderBy: { createdAt: "desc" },
      take: LIMIT,
      select: {
        id: true,
        eventId: true,
        protocol: true,
        protocolVersion: true,
        eventType: true,
        source: true,
        destination: true,
        status: true,
        payloadJson: true,
        decisionJson: true,
        pushSent: true,
        errorMessage: true,
        createdAt: true,
        processedAt: true,
      },
    });

    const events: AgentEventRow[] = rows.map((row) => ({
      id: row.id,
      eventId: row.eventId,
      protocol: row.protocol,
      protocolVersion: row.protocolVersion,
      eventType: row.eventType,
      source: row.source,
      destination: row.destination,
      status: row.status,
      payload: safeParseJson(row.payloadJson),
      decision: safeParseJson(row.decisionJson),
      pushSent: row.pushSent,
      errorMessage: row.errorMessage,
      createdAt: row.createdAt.toISOString(),
      processedAt: row.processedAt ? row.processedAt.toISOString() : null,
    }));

    const response: AgentEventsResponse = { events };
    return NextResponse.json(response);
  } catch (error) {
    logRouteError("business.agent-events.GET", error);
    return internalError("No se pudo cargar el log del bus A2A.");
  }
}
