// Dead-letter handler for the velora-a2a-events Pub/Sub subscription.
//
// Cloud Console setup required (one-time, done by operator):
//   1. Create topic: velora-a2a-dead-letter
//   2. On subscription velora-a2a-push-sub, set:
//      - Dead letter topic: velora-a2a-dead-letter
//      - Max delivery attempts: 5
//   3. Create push subscription on velora-a2a-dead-letter pointing to this endpoint.
//   4. Grant Pub/Sub SA the roles/pubsub.publisher role on the dead-letter topic.
//
// When a message exceeds max delivery attempts, Pub/Sub forwards it here.
// We log it to Cloud Logging so it never silently disappears.

import { NextRequest, NextResponse } from "next/server";
import { cloudLog, runWithTraceContext } from "@/lib/cloud-logger";
import { checkRateLimit } from "@/app/api/_lib/route-helpers";
import { verifyOidc } from "../pubsub-handler/_lib/pubsub-oidc";

export const maxDuration = 30;

export async function POST(req: NextRequest) {
  return runWithTraceContext(req.headers, () => handlePost(req));
}

async function handlePost(req: NextRequest) {
  const skipOidc = process.env.NODE_ENV !== "production" && process.env.PUBSUB_SKIP_OIDC === "true";
  if (!skipOidc) {
    const ok = await verifyOidc(req);
    if (!ok) {
      cloudLog({ severity: "WARNING", component: "System", action: "PUBSUB_OIDC_REJECTED", a2a_transfer: false, message: "Dead-letter handler rejected: OIDC validation failed" });
      return NextResponse.json({ code: "UNAUTHORIZED", message: "OIDC validation failed." }, { status: 401 });
    }
  }

  const rateLimited = checkRateLimit(req, "a2a-dead-letter", 20);
  if (rateLimited) return rateLimited;

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return NextResponse.json({ code: "INVALID_BODY", message: "Invalid JSON." }, { status: 400 });
  }

  const message = (rawBody as { message?: { data?: string; messageId?: string; attributes?: Record<string, string> } })?.message;
  const messageId = message?.messageId ?? "unknown";
  const attributes = message?.attributes ?? {};

  let decodedData: unknown = null;
  try {
    if (message?.data) {
      decodedData = JSON.parse(Buffer.from(message.data, "base64").toString("utf8"));
    }
  } catch {
    decodedData = { raw: message?.data };
  }

  cloudLog({
    severity: "ERROR",
    component: "System",
    action: "PUBSUB_DEAD_LETTER",
    a2a_transfer: false,
    message: "Pub/Sub message exceeded max delivery attempts and landed in dead-letter",
    data: { messageId, attributes, decodedData },
  });

  // ACK the dead-letter message — we've logged it, retrying again won't help.
  return new NextResponse(null, { status: 204 });
}
