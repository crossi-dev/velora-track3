// GET /api/customer-conversations
//
// Owner-only. Returns the list of customers that have at least one
// ChatMessage with source "customer" or "customer_assistant" scoped
// to the caller's businessId. Ordered by most recent activity descending.
//
// Response shape:
//   { conversations: ConversationSummary[] }
//
// ConversationSummary:
//   { customerId, customerName, customerPhone, lastMessage, lastActivityAt }
//
// Tenant isolation: all queries are gated on businessId derived from the
// authenticated actor. The caller can only see their own business's data.
//
// Pattern source: master-detail inbox (conversation list + thread view) per
// MUI master-detail docs https://mui.com/x/react-data-grid/master-detail/
// and Material Design 3 list semantics — avatar/name + supporting-text
// snippet + trailing timestamp per conversation row.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolveActor, requireRole } from "@/app/api/_lib/resolve-actor";
import {
  checkRateLimit,
  logRouteError,
  bypassIfTester,
  unauthorized,
} from "@/app/api/_lib/route-helpers";

const CUSTOMER_SOURCES = ["customer", "customer_assistant"] as const;

export async function GET(req: NextRequest) {
  const actor = await resolveActor(req);
  if (!actor) return unauthorized();

  const forbidden = requireRole(actor, ["owner"]);
  if (forbidden) return forbidden;

  const rateLimited = checkRateLimit(
    req,
    "customer-conversations-list",
    60,
    60,
    { ...bypassIfTester(actor), actorKey: actor.businessId ?? undefined },
  );
  if (rateLimited) return rateLimited;

  const { businessId } = actor;

  try {
    // Fetch the latest message per customerId for this business.
    // Strategy: get all customer-side messages grouped by customerId
    // (Prisma groupBy), then enrich with customer details in a second query.
    // This avoids raw SQL while staying within Prisma's ORM capabilities.
    //
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Prisma client regen blocked on Windows DLL lock; Cloud Build runs prisma generate fresh so prod runtime has ChatMessage.customerId.
    const grouped: any[] = await (prisma.chatMessage.groupBy as any)({
      by: ["customerId"],
      where: {
        businessId,
        customerId: { not: null },
        source: { in: [...CUSTOMER_SOURCES] },
      } as any, // eslint-disable-line @typescript-eslint/no-explicit-any -- same Prisma regen caveat
      _max: { createdAt: true },
      orderBy: { _max: { createdAt: "desc" } },
      take: 100,
    });

    // Filter out null customerId entries (safety — where clause already
    // excludes them but groupBy types allow null).
    const customerIds = (grouped as Array<{ customerId: string | null; _max: { createdAt: Date | null } }>)
      .map((g) => g.customerId)
      .filter((id): id is string => id !== null);

    if (customerIds.length === 0) {
      return NextResponse.json({ conversations: [] });
    }

    // Enrich with customer name + phone.
    const customers = await prisma.customer.findMany({
      where: { id: { in: customerIds }, businessId },
      select: { id: true, name: true, phone: true },
    });
    const customerMap = new Map(customers.map((c) => [c.id, c]));

    // Fetch the last message text per customerId (one query, ordered desc,
    // take 1 per customer using findFirst in parallel).
    const lastMessages = await Promise.all(
      customerIds.map((cid) =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- same Prisma regen caveat; customerId exists in schema, not yet in local generated client.
        (prisma.chatMessage.findFirst as any)({
          where: {
            businessId,
            customerId: cid,
            source: { in: [...CUSTOMER_SOURCES] },
          },
          orderBy: { createdAt: "desc" },
          select: { text: true },
        }),
      ),
    );

    const conversations = customerIds
      .map((cid, i) => {
        const customer = customerMap.get(cid);
        const groupRow = grouped.find((g) => g.customerId === cid);
        const lastActivityAt = (groupRow?._max?.createdAt as Date | null | undefined)?.toISOString() ?? null;
        const lastMessage = ((lastMessages[i] as { text?: string } | null)?.text ?? "").slice(0, 120);
        return {
          customerId: cid,
          customerName: customer?.name ?? "Unknown",
          customerPhone: customer?.phone ?? null,
          lastMessage,
          lastActivityAt,
        };
      })
      // Sort by lastActivityAt descending (groupBy orderBy does this but
      // re-sort after map to guarantee order after enrichment).
      .sort((a, b) => {
        if (!a.lastActivityAt) return 1;
        if (!b.lastActivityAt) return -1;
        return b.lastActivityAt.localeCompare(a.lastActivityAt);
      });

    return NextResponse.json({ conversations });
  } catch (error) {
    logRouteError("customer-conversations:GET", error);
    return NextResponse.json(
      { code: "INTERNAL_ERROR", message: "Failed to load conversations." },
      { status: 500 },
    );
  }
}
