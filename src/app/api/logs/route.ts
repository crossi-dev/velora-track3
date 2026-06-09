import { NextRequest, NextResponse } from "next/server";
import { cloudLog } from "@/lib/cloud-logger";
import { resolveActor } from "@/app/api/_lib/resolve-actor";
import { checkRateLimit } from "@/app/api/_lib/route-helpers";

const ALLOWED_ACTIONS = new Set([
  "CHAT_HISTORY_HYDRATE_FAILED",
  "CHAT_HISTORY_POLL_FAILED",
]);

const MAX_BODY_BYTES = 2048;
const MAX_MESSAGE_LEN = 200;

export async function POST(req: NextRequest): Promise<NextResponse> {
  const rl = checkRateLimit(req, "client-logs", 30, 60);
  if (rl) return rl;
  const actor = await resolveActor(req);
  if (!actor) return new NextResponse(null, { status: 401 });

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return new NextResponse(null, { status: 413 });

  let body: { action?: unknown; message?: unknown; data?: unknown };
  try {
    body = JSON.parse(raw) as { action?: unknown; message?: unknown; data?: unknown };
  } catch {
    return new NextResponse(null, { status: 400 });
  }

  if (typeof body.action !== "string" || !ALLOWED_ACTIONS.has(body.action)) {
    return new NextResponse(null, { status: 400 });
  }

  const message = typeof body.message === "string"
    ? body.message.slice(0, MAX_MESSAGE_LEN)
    : "client log";
  const data = body.data && typeof body.data === "object" && !Array.isArray(body.data)
    ? (body.data as Record<string, unknown>)
    : undefined;

  cloudLog({
    severity: "WARNING",
    component: "System",
    action: body.action,
    a2a_transfer: false,
    message,
    ...(data ? { data } : {}),
    businessId: actor.businessId,
    ...(actor.actorUserId ? { actorUserId: actor.actorUserId } : {}),
    ...(actor.actorEmployeeId ? { actorEmployeeId: actor.actorEmployeeId } : {}),
  });

  return new NextResponse(null, { status: 204 });
}
