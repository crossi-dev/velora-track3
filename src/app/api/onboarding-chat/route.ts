// Onboarding chat: multi-turn conversational endpoint that drives a
// new user through configuring their business via chat with Velora.
// Replaces the old wizard form + one-shot orchestrator. The supervisor
// asks for missing fields turn-by-turn and creates the Business +
// Products + Rules in one transaction once it has the minimum.
//
// FIX 3 — canonical onboarding path:
//   Path A (canonical): events.createUser in auth.ts creates a placeholder
//   Business row so DashboardPage renders the main chat, where the owner
//   completes onboarding inline with the supervisor.
//   Path B (fallback): if the placeholder was not created (DB error / race),
//   DashboardPage renders <OnboardingChat> which calls this endpoint directly.
//   Both paths converge here — this endpoint is the single source of truth
//   for writing the final Business record.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { checkRateLimit, logRouteError } from "@/app/api/_lib/route-helpers";
import { checkAiPerMinuteLimit } from "@/app/api/_lib/ai-rate-limit";
import { resolveActor } from "@/app/api/_lib/resolve-actor";
import { cloudLog } from "@/lib/cloud-logger";
import { getServerActionMeta, type RouteMutationDeclaration } from "@/app/api/_lib/mutation-contract";
import { prismaBusinessRepository } from "@/infrastructure/persistence/prisma-business.repository";
import { prismaAuditAdapter } from "@/infrastructure/persistence/prisma-audit.adapter";
import {
  runOnboardingTurn,
  finalizeOnboarding,
  OnboardingParseError,
  type ChatTurn,
} from "./_lib/conversation";
import { OnboardingBusinessSpecSchema } from "./_lib/conversation-schema";

export const maxDuration = 30;

const MUTATION_ACTIONS = {
  POST: "onboarding.chat",
} as const satisfies RouteMutationDeclaration;
const ONBOARDING_CHAT_ACTION = getServerActionMeta(MUTATION_ACTIONS.POST);

const MAX_TURNS = 12;
// FIX 4: at this turn count, auto-finalize instead of returning 400
const GRACEFUL_WRAP_TURN = 11;
const MAX_CONTENT_LENGTH = 1000;

function validateHistory(raw: unknown): ChatTurn[] {
  if (!Array.isArray(raw)) throw new Error("history must be an array");
  // FIX 4: allow up to MAX_TURNS+1 so we can read the last user turn
  // and finalize gracefully instead of returning a hard 400
  if (raw.length > MAX_TURNS + 1) throw new Error("history too long");
  return raw.map((t, idx) => {
    const turn = t as { role?: unknown; content?: unknown };
    if (turn.role !== "user" && turn.role !== "assistant") {
      throw new Error(`turn[${idx}] role must be user or assistant`);
    }
    if (typeof turn.content !== "string" || !turn.content.trim()) {
      throw new Error(`turn[${idx}] content missing`);
    }
    return { role: turn.role, content: turn.content.slice(0, MAX_CONTENT_LENGTH) };
  });
}

// 32 KB is generous for onboarding: MAX_TURNS=12 × MAX_CONTENT_LENGTH=1000 chars.
const ONBOARDING_MAX_BODY_BYTES = 32 * 1024;

export async function POST(req: NextRequest) {
  const contentLength = Number(req.headers.get("content-length") ?? "0");
  if (contentLength > ONBOARDING_MAX_BODY_BYTES) {
    return NextResponse.json({ code: "PAYLOAD_TOO_LARGE", message: "Request body too large." }, { status: 413 });
  }

  const rateLimited = checkRateLimit(req, "ai", 30, 60);
  if (rateLimited) return rateLimited;

  const actor = await resolveActor(req);
  if (!actor) {
    return NextResponse.json({ code: "UNAUTHORIZED", message: "Authentication required." }, { status: 401 });
  }
  if (actor.role !== "owner") {
    return NextResponse.json({ code: "FORBIDDEN", message: "Solo el dueño puede acceder a esto." }, { status: 403 });
  }

  if (!actor.isTester && !(await checkAiPerMinuteLimit(actor.actorUserId))) {
    return NextResponse.json({ code: "RATE_LIMITED", message: "Too many requests. Please wait a moment." }, { status: 429 });
  }

  let history: ChatTurn[];
  try {
    const body = (await req.json()) as { history?: unknown };
    history = validateHistory(body.history);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Body inválido.";
    return NextResponse.json({ code: "INVALID_HISTORY", message }, { status: 400 });
  }

  if (history.length === 0 || history[history.length - 1]?.role !== "user") {
    return NextResponse.json({ code: "INVALID_HISTORY", message: "The last turn must be from the user." }, { status: 400 });
  }

  // FIX 4: at turn GRACEFUL_WRAP_TURN or beyond, force action="create" so the
  // conversation closes gracefully with whatever was collected, instead of
  // returning a 400 "history too long" error to the user.
  const atTurnLimit = history.length >= GRACEFUL_WRAP_TURN;

  try {
    const result = await runOnboardingTurn(history);

    // FIX 4: if at the turn limit, override action to "create" regardless of
    // what the model returned. The wrap-up message is injected below.
    const action = atTurnLimit ? "create" : result.action;

    if (action === "ask") {
      return NextResponse.json({ message: result.message, complete: false });
    }

    // action === "create" — finalize with whatever data was collected.
    // Check for an existing business only at this point (not on every ask turn)
    // to avoid a DB roundtrip on each of the 12 conversational turns.
    const existing = await prismaBusinessRepository.findByUserId(actor.actorUserId);
    if (existing) {
      return NextResponse.json({ code: "BUSINESS_ALREADY_EXISTS", message: "A business already exists for this account.", businessId: existing.id }, { status: 409 });
    }

    const wrapUpPrefix = atTurnLimit && result.action === "ask"
      ? "Ya tengo lo básico — vamos a arrancar. Podés completar el resto desde Ajustes.\n\n"
      : "";

    // Fetch user profile for onboarding finalization; native-bearer path
    // doesn't carry name/image in token, but User row was created at OAuth time.
    const userRow = await prisma.user.findUnique({
      where: { id: actor.actorUserId },
      select: { email: true, name: true, image: true },
    });

    // LLM02 guard: re-validate the spec that will be written to DB. runOnboardingTurn
    // already validates via OnboardingTurnResultSchema, but an explicit parse here
    // ensures no code path can reach finalizeOnboarding with an unvalidated spec
    // (e.g. if the atTurnLimit branch bypasses safeParse in a future refactor).
    const safeSpec = OnboardingBusinessSpecSchema.parse(result.businessSpec);

    const finalized = await finalizeOnboarding({
      userId: actor.actorUserId,
      userEmail: userRow?.email,
      userName: userRow?.name,
      userImage: userRow?.image,
      spec: safeSpec,
    });

    void prismaAuditAdapter.recordCriticalWrite({
      businessId: finalized.businessId,
      actorUserId: actor.actorUserId,
      routeScope: ONBOARDING_CHAT_ACTION.routeScope,
      actionType: ONBOARDING_CHAT_ACTION.actionType,
      resourceType: ONBOARDING_CHAT_ACTION.resourceType,
      resourceId: finalized.businessId,
      summary: `Onboarding via chat: ${safeSpec.businessName}`,
      payload: {
        businessName: safeSpec.businessName,
        productsCount: safeSpec.products.length,
        rulesCount: safeSpec.rules.length,
      },
    }).catch((err: unknown) => {
      cloudLog({ severity: "WARNING", component: "System", action: "ONBOARDING_AUDIT_FAILED", a2a_transfer: false, message: "Onboarding chat audit write failed (best-effort)", businessId: finalized.businessId, data: { error: err instanceof Error ? err.message : String(err) } });
    });

    const baseUrl = process.env.AUTH_URL ?? process.env.NEXTAUTH_URL ?? "https://www.somosvelora.com";
    let message = wrapUpPrefix + result.message;
    const employeeAccess = safeSpec.employees.map((emp) => ({
      name: emp.name,
      pin: emp.pin,
      loginUrl: `${baseUrl}/employee-login?b=${finalized.businessId}`,
    }));

    if (employeeAccess.length > 0) {
      const names = employeeAccess.map((e) => e.name).join(", ");
      message +=
        `\n\nListo — ya creé el acceso para ${names}. Andá a la sección Equipo para ver el código de cada uno y compartirlo por WhatsApp.`;
    }

    return NextResponse.json({
      message,
      complete: true,
      businessId: finalized.businessId,
      // employeeAccess entregado al cliente para mostrar TeamSuccessBanner.
      // El PIN viaja en el response HTTP (HTTPS), NO se persiste en DB de chat.
      employeeAccess,
    });
  } catch (err) {
    // FIX 5: LLM returned malformed JSON on both attempts — show a friendly
    // retry message instead of a 500. The conversation state is intact on the
    // client; they can resend the last message to trigger a fresh LLM call.
    if (err instanceof OnboardingParseError) {
      cloudLog({
        severity: "WARNING",
        component: "System",
        action: "ONBOARDING_CHAT_PARSE_EXHAUSTED",
        a2a_transfer: false,
        message: "onboarding-chat: both parse attempts failed — returning friendly error",
        data: { cause: err.message },
      });
      return NextResponse.json(
        { code: "ONBOARDING_PARSE_ERROR", message: "Disculpá, tuve un hipo. Repetí lo último." },
        { status: 200 },
      );
    }

    // P2002 on Business.userId means a concurrent request won the race and already
    // created the business. The DB unique constraint (Business.userId @unique) prevents
    // any duplicate — integrity is intact. Surface it as 409 instead of 500.
    const errCode = err && typeof err === "object" && "code" in err
      ? (err as { code?: unknown }).code
      : undefined;
    if (errCode === "P2002") {
      const created = await prismaBusinessRepository.findByUserId(actor.actorUserId);
      if (created) {
        return NextResponse.json(
          { code: "BUSINESS_ALREADY_EXISTS", message: "A business already exists for this account.", businessId: created.id },
          { status: 409 },
        );
      }
    }
    logRouteError("onboarding-chat", err);
    return NextResponse.json(
      { code: "ONBOARDING_CHAT_FAILED", message: "Could not process the response. Please try again." },
      { status: 500 },
    );
  }
}
