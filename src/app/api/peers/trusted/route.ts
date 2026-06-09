// GET  /api/peers/trusted — list trusted peers for the business
// POST /api/peers/trusted — add a trusted peer by domain
// DELETE /api/peers/trusted — remove a trusted peer by domain

import { NextRequest, NextResponse } from "next/server";
import {
  checkRateLimit,
  internalError,
  logRouteError,
  unauthorized,
} from "@/app/api/_lib/route-helpers";
import { resolveActor, requireRole } from "@/app/api/_lib/resolve-actor";
import {
  listTrustedPeers,
  addTrustedPeer,
  removeTrustedPeer,
} from "@/lib/a2a-trust";
import type { PeerAgentCard } from "@/lib/a2a-discovery";

// ── GET — list ──────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  // Resolve actor first so we can key the rate limiter by businessId, not IP.
  // Avoids CGNAT collisions where multiple businesses share one egress IP.
  const ctx = await resolveActor(req);
  if (!ctx) return unauthorized();
  const roleGate = requireRole(ctx, ["owner"]);
  if (roleGate) return roleGate;

  const rateLimited = checkRateLimit(req, "peers-trusted", 30, 60, { actorKey: ctx.businessId });
  if (rateLimited) return rateLimited;

  try {
    const peers = await listTrustedPeers(ctx.businessId);
    // Parse agentCardJson to surface skills list for the UI
    const enriched = peers.map((p) => {
      let skills: PeerAgentCard["skills"] = [];
      if (p.agentCardJson) {
        try {
          const card = JSON.parse(p.agentCardJson) as PeerAgentCard;
          skills = card.skills ?? [];
        } catch {
          // noop — malformed json, skills stay empty
        }
      }
      return {
        id: p.id,
        domain: p.domain,
        agentName: p.agentName,
        skills,
        addedAt: p.addedAt.toISOString(),
        lastUsedAt: p.lastUsedAt?.toISOString() ?? null,
      };
    });
    return NextResponse.json({ peers: enriched });
  } catch (error) {
    logRouteError("peers/trusted GET", error);
    return internalError("No se pudo listar los peers de confianza.");
  }
}

// ── POST — add ──────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const rateLimited = checkRateLimit(req);
  if (rateLimited) return rateLimited;

  const ctx = await resolveActor(req);
  if (!ctx) return unauthorized();
  const roleGate = requireRole(ctx, ["owner"]);
  if (roleGate) return roleGate;

  let domain: string;
  try {
    const body = (await req.json()) as { domain?: string };
    domain = (body.domain ?? "").trim();
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  if (!domain) {
    return NextResponse.json({ error: "domain requerido" }, { status: 400 });
  }

  try {
    const result = await addTrustedPeer(ctx.businessId, domain);
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 422 });
    }
    return NextResponse.json({
      ok: true,
      agentName: result.agentCard?.name,
      skills: result.agentCard?.skills ?? [],
    });
  } catch (error) {
    logRouteError("peers/trusted POST", error);
    return internalError("No se pudo agregar el peer.");
  }
}

// ── DELETE — remove ─────────────────────────────────────────────────────────

export async function DELETE(req: NextRequest) {
  const rateLimited = checkRateLimit(req);
  if (rateLimited) return rateLimited;

  const ctx = await resolveActor(req);
  if (!ctx) return unauthorized();
  const roleGate = requireRole(ctx, ["owner"]);
  if (roleGate) return roleGate;

  let domain: string;
  try {
    const body = (await req.json()) as { domain?: string };
    domain = (body.domain ?? "").trim();
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  if (!domain) {
    return NextResponse.json({ error: "domain requerido" }, { status: 400 });
  }

  try {
    await removeTrustedPeer(ctx.businessId, domain);
    return NextResponse.json({ ok: true });
  } catch (error) {
    logRouteError("peers/trusted DELETE", error);
    return internalError("No se pudo quitar el peer.");
  }
}
