import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { checkRateLimit, logRouteError } from "@/app/api/_lib/route-helpers";
import { resolveActor } from "@/app/api/_lib/resolve-actor";
import { checkAiPerMinuteLimit } from "@/app/api/_lib/ai-rate-limit";
import { cloudLog } from "@/lib/cloud-logger";
import { getIdempotencyKey } from "@/app/api/_lib/idempotency";
import { getServerActionMeta, type RouteMutationDeclaration } from "@/app/api/_lib/mutation-contract";
import { prismaBusinessRepository } from "@/infrastructure/persistence/prisma-business.repository";
import { prismaIdempotencyAdapter } from "@/infrastructure/persistence/prisma-idempotency.adapter";
import { prismaAuditAdapter } from "@/infrastructure/persistence/prisma-audit.adapter";
import { parseOnboardingDescription } from "./_lib/orchestrator-parser";
import { executeOnboardingOrchestration } from "./_lib/orchestrator-executor";

// Total AI budget: 9s Gemini + 3s transaction = 12s
export const maxDuration = 20;

const MUTATION_ACTIONS = {
  POST: "onboarding.orchestrate",
} as const satisfies RouteMutationDeclaration;
const ORCHESTRATE_ACTION = getServerActionMeta(MUTATION_ACTIONS.POST);

export async function POST(req: NextRequest) {
  const rateLimited = checkRateLimit(req, "ai", 30, 60);
  if (rateLimited) return rateLimited;

  const actor = await resolveActor(req);
  if (!actor) {
    return NextResponse.json({ code: "UNAUTHORIZED", message: "Authentication required." }, { status: 401 });
  }
  if (actor.role !== "owner") {
    return NextResponse.json({ code: "FORBIDDEN", message: "Solo el dueño puede acceder a esto." }, { status: 403 });
  }

  if (!(await checkAiPerMinuteLimit(actor.actorUserId))) {
    return NextResponse.json({ code: "RATE_LIMITED", message: "Too many requests. Please wait a moment." }, { status: 429 });
  }

  const existing = await prismaBusinessRepository.findByUserId(actor.actorUserId);
  if (existing) return NextResponse.json({ code: "BUSINESS_ALREADY_EXISTS", message: "A business already exists for this account." }, { status: 409 });

  let idempotencyRecordId: string | null = null;
  const idempotencyKey = getIdempotencyKey(req);

  try {
    const { text } = await req.json() as { text?: unknown };
    if (typeof text !== "string" || !text.trim()) {
      return NextResponse.json({ code: "MISSING_DESCRIPTION", message: "Business description is required." }, { status: 400 });
    }

    if (idempotencyKey) {
      const gate = await prismaIdempotencyAdapter.begin({
        businessId: actor.actorUserId,
        actionType: ORCHESTRATE_ACTION.actionType,
        idempotencyKey,
        requestBody: { text: text.slice(0, 100) },
      });
      if (gate.kind === "replay") return NextResponse.json(gate.body, { status: gate.status });
      if (gate.kind === "in_flight" || gate.kind === "conflict") {
        return NextResponse.json({ code: "IN_FLIGHT", message: "This request is already being processed." }, { status: 409 });
      }
      if (gate.kind === "execute") idempotencyRecordId = gate.recordId;
    }

    const parsed = await parseOnboardingDescription(text.slice(0, 800));

    if (!parsed.businessName?.trim()) {
      return NextResponse.json({ code: "MISSING_BUSINESS_NAME", message: "Could not detect a business name. Please be more specific." }, { status: 422 });
    }

    // Fetch user profile for orchestration; native-bearer token carries userId only.
    const userRow = await prisma.user.findUnique({
      where: { id: actor.actorUserId },
      select: { email: true, name: true, image: true },
    });

    const result = await executeOnboardingOrchestration(
      actor.actorUserId,
      userRow?.email,
      userRow?.name,
      userRow?.image,
      parsed,
    );

    void prismaAuditAdapter.recordCriticalWrite({
      businessId: result.businessId,
      actorUserId: actor.actorUserId,
      routeScope: ORCHESTRATE_ACTION.routeScope,
      actionType: ORCHESTRATE_ACTION.actionType,
      resourceType: ORCHESTRATE_ACTION.resourceType,
      resourceId: result.businessId,
      summary: `Onboarding orquestado: ${parsed.businessName}`,
      payload: { businessName: parsed.businessName, productsCount: parsed.products.length },
    }).catch((err: unknown) => {
      cloudLog({ severity: "WARNING", component: "System", action: "ONBOARDING_AUDIT_FAILED", a2a_transfer: false, message: "Onboarding audit write failed (best-effort)", businessId: result.businessId, data: { error: err instanceof Error ? err.message : String(err) } });
    });

    const responseBody = { ok: true, businessId: result.businessId, steps: result.steps };
    if (idempotencyRecordId) {
      await prismaIdempotencyAdapter.complete(null, idempotencyRecordId, 201, responseBody);
    }
    return NextResponse.json(responseBody, { status: 201 });
  } catch (err) {
    await prismaIdempotencyAdapter.release(idempotencyRecordId);
    logRouteError("onboarding-orchestrator", err);
    return NextResponse.json({ code: "ORCHESTRATION_FAILED", message: "Could not process the request. Please try again." }, { status: 500 });
  }
}
