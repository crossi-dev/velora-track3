// GET /api/customer-conversations/[customerId]
//
// Owner-only. Returns the full message thread for a specific customer,
// scoped to the caller's businessId. Messages are ordered chronologically
// (oldest first) for conversation display.
//
// Response shape:
//   { thread: ThreadMessage[], customer: { id, name, phone } | null }
//
// ThreadMessage:
//   { id, source, text, createdAt }
//
// Tenant isolation: both the Customer lookup and the ChatMessage query are
// gated on businessId. A customer that belongs to a different business
// returns 404 — the caller never learns the customer exists.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolveActor, requireRole } from "@/app/api/_lib/resolve-actor";
import {
  checkRateLimit,
  logRouteError,
  bypassIfTester,
  unauthorized,
  notFound,
} from "@/app/api/_lib/route-helpers";

const CUSTOMER_SOURCES = ["customer", "customer_assistant"] as const;
const MAX_THREAD_MESSAGES = 200;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ customerId: string }> },
) {
  const actor = await resolveActor(req);
  if (!actor) return unauthorized();

  const forbidden = requireRole(actor, ["owner"]);
  if (forbidden) return forbidden;

  const rateLimited = checkRateLimit(
    req,
    "customer-conversations-thread",
    120,
    60,
    { ...bypassIfTester(actor), actorKey: actor.businessId ?? undefined },
  );
  if (rateLimited) return rateLimited;

  const { businessId } = actor;
  const { customerId } = await params;

  if (!customerId?.trim()) {
    return NextResponse.json(
      { code: "BAD_REQUEST", message: "Missing customerId." },
      { status: 400 },
    );
  }

  try {
    // Verify the customer belongs to this business — tenant isolation.
    // Returns 404 if the customer doesn't exist or belongs to another tenant.
    const customer = await prisma.customer.findFirst({
      where: { id: customerId, businessId },
      select: { id: true, name: true, phone: true },
    });

    if (!customer) return notFound("Customer not found.");

    const messages = await (prisma.chatMessage.findMany as any)({ // eslint-disable-line @typescript-eslint/no-explicit-any -- Prisma client regen blocked on Windows DLL lock; Cloud Build runs prisma generate fresh so prod runtime has ChatMessage.customerId.
      where: {
        businessId,
        customerId,
        source: { in: [...CUSTOMER_SOURCES] },
      } as any, // eslint-disable-line @typescript-eslint/no-explicit-any -- same Prisma regen caveat
      orderBy: { createdAt: "asc" },
      take: MAX_THREAD_MESSAGES,
      select: {
        id: true,
        source: true,
        text: true,
        createdAt: true,
      },
    });

    const thread = (messages as Array<{ id: string; source: string; text: string; createdAt: Date }>).map((m) => ({
      id: m.id,
      source: m.source,
      text: m.text,
      createdAt: m.createdAt.toISOString(),
    }));

    return NextResponse.json({
      thread,
      customer: {
        id: customer.id,
        name: customer.name,
        phone: customer.phone ?? null,
      },
    });
  } catch (error) {
    logRouteError("customer-conversations/thread:GET", error);
    return NextResponse.json(
      { code: "INTERNAL_ERROR", message: "Failed to load thread." },
      { status: 500 },
    );
  }
}
