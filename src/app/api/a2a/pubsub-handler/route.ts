// Pub/Sub Push Subscription handler — recibe mensajes desde el topic
// `velora-a2a-events` que el agente Empleado publicó. Procesa el evento
// vía supervisor + escribe en AgentEventLog + dispara push si aplica.
//
// Flow:
//   1. Pub/Sub envía POST con OIDC token en Authorization header.
//   2. Validamos el OIDC (audience = nuestra URL, issuer = google).
//   3. Decodificamos el message.data (base64 → JSON EmployeeEvent).
//   4. Procesamos via runSupervisor → notification → push.
//   5. Retornamos status según error class (transient vs permanent).
//
// Error handling discriminado:
//   - Transient (Supabase hipo, network blip) → 503 → Pub/Sub retry.
//   - Permanent (datos inválidos, ya procesado) → 204 → ACK.
//   - Unknown → 503 (mejor que perder mensaje).

import { NextRequest, NextResponse } from "next/server";
import { parseEmployeeEvent } from "@/lib/agent-contract";
import { cloudLog, runWithTraceContext } from "@/lib/cloud-logger";
import { verifyOidc, type PubSubPushBody } from "./_lib/pubsub-oidc";
import { processEvent } from "./_lib/pubsub-process-event";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  return runWithTraceContext(req.headers, () => handlePost(req));
}

async function handlePost(req: NextRequest) {
  const skipOidc = process.env.NODE_ENV !== "production" && process.env.PUBSUB_SKIP_OIDC === "true";
  if (!skipOidc) {
    const ok = await verifyOidc(req);
    if (!ok) {
      cloudLog({ severity: "WARNING", component: "System", action: "PUBSUB_OIDC_REJECTED", a2a_transfer: false, message: "Pub/Sub push handler rejected: OIDC validation failed" });
      return new NextResponse(null, { status: 401 });
    }
  }

  let body: PubSubPushBody;
  try {
    body = (await req.json()) as PubSubPushBody;
  } catch {
    return new NextResponse(null, { status: 400 });
  }

  const messageData = body.message?.data;
  if (typeof messageData !== "string" || messageData.length === 0) {
    return new NextResponse(null, { status: 400 });
  }

  let raw: unknown;
  try {
    const decoded = Buffer.from(messageData, "base64").toString("utf-8");
    raw = JSON.parse(decoded);
  } catch {
    return new NextResponse(null, { status: 400 });
  }

  const event = parseEmployeeEvent(raw);
  if (!event) {
    cloudLog({ severity: "ERROR", component: "System", action: "PUBSUB_INVALID_PAYLOAD", a2a_transfer: false, message: "Pub/Sub push handler got payload that failed contract validation", data: { messageId: body.message?.messageId } });
    return new NextResponse(null, { status: 204 });
  }

  // Cross-check: attribute businessId must match payload businessId.
  const attrBusinessId = body.message?.attributes?.businessId;
  if (attrBusinessId && attrBusinessId !== event.businessId) {
    cloudLog({ severity: "ERROR", component: "System", action: "PUBSUB_BUSINESSID_MISMATCH", a2a_transfer: false, message: "Pub/Sub message attribute businessId does not match payload businessId — rejecting", data: { attrBusinessId, payloadBusinessId: event.businessId, messageId: body.message?.messageId } });
    return new NextResponse(null, { status: 204 });
  }

  return processEvent(event);
}
