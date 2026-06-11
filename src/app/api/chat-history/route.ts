import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { checkRateLimit, logRouteError, bypassIfTester } from "@/app/api/_lib/route-helpers";
import { parseZodBody } from "@/app/api/_lib/zod-body";
import { recordCriticalWriteEvent } from "@/infrastructure/shared/critical-write-audit";
import { redactPii } from "@/lib/chat-history-redact";
import { chatMessageVisibilityFilter } from "@/app/api/business-assistant/_lib/visibility-filter";
import { resolveActor, requireRole } from "@/app/api/_lib/resolve-actor";
import { chipsSchema } from "./_lib/chips-schema";
import { maybeSeedOnboardingTurn1 } from "./_lib/onboarding-seed";
import { HOP_PROCESSING_RESOLVED_SENTINEL } from "@/app/api/payment-intents/_lib/payment-intent-post-confirm.hop-chat";

/**
 * POST /api/chat-history schema.
 *
 * `source` must be one of: "owner" | "employee" | "assistant" | "manager".
 * Do NOT pass "user" (Vercel AI SDK default) — the server derives the correct
 * source from the authenticated actor for "user" kind rows and rejects the
 * literal string "user" with a 400 to prevent silent source poisoning.
 * Ref: https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-message-persistence
 */
const chatHistoryPostSchema = z.object({
  clientMessageId: z.string().min(1, "clientMessageId is required."),
  kind: z.enum(["user", "reply", "error", "success"], {
    errorMap: () => ({ message: "Invalid message kind." }),
  }),
  source: z.enum(["owner", "employee", "assistant", "manager"], {
    errorMap: () => ({ message: "Invalid source. Use 'owner', 'employee', 'assistant', or 'manager'. Do not use 'user' — the server derives source from the authenticated actor." }),
  }).optional(),
  text: z.string().min(1, "Message text is empty.").max(2000),
  timestamp: z.number().finite().optional(),
  chips: chipsSchema,
});
const RESET_KIND = "chat_reset";

function toBoundedLimit(raw: string | null) {
  const parsed = Number(raw ?? "240");
  if (!Number.isFinite(parsed)) return 240;
  const rounded = Math.floor(parsed);
  return Math.max(1, Math.min(500, rounded));
}

function parseTimestamp(raw: unknown) {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

export async function GET(req: NextRequest) {
  // Resolve actor BEFORE the rate-limit check so tester accounts bypass the
  // per-IP limit. Chat-history is polled frequently by the UI; a single tester
  // session can otherwise hit 120/min from a few minutes of normal use.
  const actor = await resolveActor(req);
  if (!actor) {
    return NextResponse.json({ code: "UNAUTHORIZED", message: "Authentication required." }, { status: 401 });
  }

  // chat-history GET is polled every ~2s by the UI. Cap raised to 600/min
  // (2× prior 300) to give demo-day owners headroom across multiple tabs.
  // Key by businessId:actorUserId — prevents a single actor from exhausting the
  // shared budget in multi-owner/multi-employee scenarios.
  // Ref: B13 finding 9 — per-user rate-limit key for chat-poll bucket.
  const rateLimited = checkRateLimit(req, "chat-poll", 600, 60, {
    ...bypassIfTester(actor),
    actorKey: actor.businessId && actor.actorUserId ? `${actor.businessId}:${actor.actorUserId}` : (actor.businessId ?? undefined),
  });
  if (rateLimited) return rateLimited;

  try {
    const { businessId, actorEmployeeId } = actor;
    if (!businessId) {
      return NextResponse.json({ messages: [], clearedAt: null });
    }

    // Seed proactivo del Turno 1 ANTES de leer la lista — así si el dueño
    // recién entra, la fila ya está y aparece en la query siguiente.
    // actorUserId is passed so the seed can personalize the greeting with
    // the owner's first name from Google OAuth (e.g. "Hola Carlos.").
    await maybeSeedOnboardingTurn1(businessId, !actorEmployeeId, actor.actorUserId);

    const latestReset = await prisma.chatMessage.findFirst({
      where: { businessId, kind: RESET_KIND },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });

    const clearedAt = latestReset?.createdAt ?? null;
    const limit = toBoundedLimit(req.nextUrl.searchParams.get("limit"));
    const actorKind = actorEmployeeId ? "employee" : "owner";
    const rows = await prisma.chatMessage.findMany({
      where: {
        businessId,
        kind: { not: RESET_KIND },
        // Exclude resolved ⏳ hop-processing rows — sentinel written by
        // markHopProcessingResolved after hop 2 (comprobante) succeeds.
        // The poll reconciler removes the bubble from UI on the next 3s cycle.
        text: { not: HOP_PROCESSING_RESOLVED_SENTINEL },
        ...(clearedAt ? { createdAt: { gte: clearedAt } } : {}),
        ...chatMessageVisibilityFilter({ kind: actorKind, employeeId: actorEmployeeId ?? undefined }),
      },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: {
        clientMessageId: true,
        kind: true,
        source: true,
        text: true,
        chips: true,
        createdAt: true,
      },
    });

    return NextResponse.json({
      messages: rows.reverse().map((row) => ({
        id: `msg:${row.clientMessageId}`,
        source: row.source,
        kind: row.kind,
        text: row.text,
        chips: row.chips ?? null,
        createdAt: row.createdAt.toISOString(),
      })),
      clearedAt: clearedAt?.toISOString() ?? null,
    });
  } catch (error) {
    logRouteError("chat-history:GET", error);
    return NextResponse.json({ code: "CHAT_HISTORY_LOAD_FAILED", message: "Failed to load chat history." }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const actor = await resolveActor(req);
  if (!actor) {
    return NextResponse.json({ code: "UNAUTHORIZED", message: "Authentication required." }, { status: 401 });
  }

  // POST writes a single chat message — cap raised to 120/min (2× prior 60)
  // for demo headroom. Keyed by businessId. Per-user scoping NOT implemented
  // (team/employee dimension shelved).
  const rateLimited = checkRateLimit(req, "chat-write", 120, 60, {
    ...bypassIfTester(actor),
    actorKey: actor.businessId ?? undefined,
  });
  if (rateLimited) return rateLimited;

  try {
    const businessId = actor.businessId;
    if (!businessId) {
      return NextResponse.json({ code: "BUSINESS_NOT_FOUND", message: "Business not found." }, { status: 404 });
    }

    const parsed = await parseZodBody(req, chatHistoryPostSchema);
    if (!parsed.ok) return parsed.response;

    const { clientMessageId, kind, source, timestamp, chips } = parsed.data;

    // Redact PII before persistence (write-path only — see policy at top of file).
    const text = redactPii(parsed.data.text);

    const createdAt = parseTimestamp(timestamp);

    // H2: for kind "user" rows the server derives source from the authenticated
    // actor, overriding any client-supplied value. This prevents the default
    // "assistant" string from poisoning user-input rows.
    // For reply/error/success rows the client-supplied source is trusted (or
    // "assistant" is used as fallback), because only the AI produces those rows.
    // Ref: https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-message-persistence
    const resolvedSource: string =
      kind === "user"
        ? (actor.actorEmployeeId ? "employee" : "owner")
        : (source ?? "assistant");

    await prisma.chatMessage.upsert({
      where: {
        businessId_clientMessageId: {
          businessId,
          clientMessageId,
        },
      },
      update: {},
      create: {
        businessId,
        clientMessageId,
        kind,
        source: resolvedSource,
        text,
        ...(chips ? { chips } : {}),
        ...(createdAt ? { createdAt } : {}),
      },
    });

    await recordCriticalWriteEvent({
      client: prisma,
      businessId,
      actorUserId: actor.actorUserId,
      routeScope: "chat-history",
      actionType: "chat-history.append",
      resourceType: "chat-message",
      resourceId: clientMessageId,
      summary: `Chat registrado (${kind})`,
      payload: {
        clientMessageId,
        kind,
        createdAt: createdAt?.toISOString() ?? null,
      },
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    // Signal retryable failure so the UI can back off and re-queue the write.
    logRouteError("chat-history:POST", error);
    return NextResponse.json(
      { code: "CHAT_HISTORY_WRITE_FAILED", message: "Failed to save chat message.", retryable: true },
      { status: 503 }
    );
  }
}

export async function DELETE(req: NextRequest) {
  const actor = await resolveActor(req);
  if (!actor) {
    return NextResponse.json({ code: "UNAUTHORIZED", message: "Authentication required." }, { status: 401 });
  }
  const forbidden = requireRole(actor, ["owner"]);
  if (forbidden) return forbidden;

  // DELETE clears chat — low frequency, 10/min per business.
  const rateLimited = checkRateLimit(req, "chat-clear", 10, 60, {
    ...bypassIfTester(actor),
    actorKey: actor.businessId ?? undefined,
  });
  if (rateLimited) return rateLimited;

  try {
    const businessId = actor.businessId;
    if (!businessId) {
      return NextResponse.json({ ok: true, clearedAt: null });
    }

    const clearedAt = new Date();

    // GROWTH NOTE (Fix #36): El "clear" elimina todos los mensajes anteriores y deja solo el
    // marcador de reset. Esto es un hard-delete real de los mensajes — no hay acumulación.
    // El marcador de reset (kind="chat_reset") permanece para que GET filtre desde ese punto.
    // Los marcadores de reset en sí acumulan 1 fila por cada clear del usuario, lo cual es
    // negligible (típicamente 1 reset cada varios días). Aceptable para MVP.
    // Post-launch: si un usuario acumula muchos resets, se puede limpiar el historial de
    // marcadores manteniendo solo el más reciente. No se necesita acción ahora.
    await prisma.$transaction(async (tx) => {
      await tx.chatMessage.deleteMany({
        where: { businessId },
      });

      await tx.chatMessage.create({
        data: {
          businessId,
          clientMessageId: `clear:${crypto.randomUUID()}`,
          kind: RESET_KIND,
          text: "clear-chat",
          createdAt: clearedAt,
        },
      });
    });

    await recordCriticalWriteEvent({
      client: prisma,
      businessId,
      actorUserId: actor.actorUserId,
      routeScope: "chat-history",
      actionType: "chat-history.clear",
      resourceType: "chat-message",
      resourceId: "reset",
      summary: "Chat limpiado",
      payload: {
        clearedAt: clearedAt.toISOString(),
      },
    });

    return NextResponse.json({ ok: true, clearedAt: clearedAt.toISOString() });
  } catch (error) {
    logRouteError("chat-history:DELETE", error);
    return NextResponse.json({ code: "CHAT_HISTORY_CLEAR_FAILED", message: "Failed to clear chat history." }, { status: 500 });
  }
}
