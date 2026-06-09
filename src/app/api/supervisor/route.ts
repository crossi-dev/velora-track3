// Tier 4 — Supervisor (Bible §4): thin HTTP adapter.
// All business logic lives in _lib/supervisor-runner.ts.
// This module only handles NextRequest → runner → NextResponse.

import { NextRequest, NextResponse } from "next/server";
import { checkRateLimit, logRouteError } from "@/app/api/_lib/route-helpers";
import { resolveActor } from "@/app/api/_lib/resolve-actor";
import { reportWarning, runWithTraceContext } from "@/lib/cloud-logger";
import { checkAiRateLimit, checkAiPerMinuteLimit } from "@/app/api/_lib/ai-rate-limit";
import { loadSupervisorContext } from "./_lib/load-context";
import { safeParseJson } from "./_lib/supervisor-parser";
import { applySupervisorHallucinationGuard } from "./_lib/supervisor-hallucination-guard";
import { callSupervisor } from "./_lib/supervisor-runner";
import type { SupervisorResponse } from "./_lib/supervisor-response";

export const maxDuration = 40;

export async function POST(req: NextRequest) {
  return runWithTraceContext(req.headers, () => handlePost(req));
}

async function handlePost(req: NextRequest) {
  const rateLimited = checkRateLimit(req, "ai", 30, 60);
  if (rateLimited) return rateLimited;

  const actor = await resolveActor(req);
  if (!actor) return NextResponse.json({ code: "UNAUTHORIZED", message: "Authentication required." }, { status: 401 });
  if (actor.role !== "owner") {
    return NextResponse.json({ code: "FORBIDDEN", message: "Solo el dueño puede acceder a esto." }, { status: 403 });
  }

  if (!actor.isTester && !(await checkAiPerMinuteLimit(actor.actorUserId))) {
    return NextResponse.json({ code: "RATE_LIMITED", message: "Too many requests. Please wait a moment." }, { status: 429 });
  }
  const allowed = actor.isTester || (await checkAiRateLimit(actor.actorUserId));
  if (!allowed) {
    return NextResponse.json({ code: "DAILY_LIMIT_REACHED", message: "Daily request limit reached. Try again tomorrow." }, { status: 429 });
  }

  if (!actor.businessId) return NextResponse.json({ code: "BUSINESS_NOT_FOUND", message: "No business found for this user." }, { status: 404 });
  const biz = { id: actor.businessId };

  try {
    const { text: rawText, lang: rawLang } = (await req.json()) as { text?: unknown; lang?: unknown };
    const text: string = typeof rawText === "string" ? rawText.slice(0, 4000) : "";
    if (!text.trim()) {
      return NextResponse.json({ code: "MISSING_TEXT", message: "Input text is required." }, { status: 400 });
    }
    const lang: "en" | "es-AR" = rawLang === "en" ? "en" : "es-AR";

    const ctx = await loadSupervisorContext(biz.id);
    const { raw, usedModel } = await callSupervisor(text, {
      businessId: biz.id,
      activeRules: ctx.activeRules,
      activePolicies: ctx.activePolicies,
      onboardingState: {
        productCount: ctx.productCount,
        productsWithoutStock: ctx.productsWithoutStock,
        employeeCount: ctx.employeeCount,
        businessNameSet: ctx.businessNameSet,
        businessTypeSet: ctx.businessTypeSet,
        paymentMethodsSet: ctx.paymentMethodsSet,
        // openingCashSet removed: Fase B removed the opening-cash turn; the field
        // is never set for new businesses and must not gate onboarding completion.
      },
      products: ctx.products,
      employees: ctx.employees,
      cashBalance: ctx.cashBalance,
      currency: ctx.currency,
      lang,
    });
    const parsed = safeParseJson(raw);
    if (!parsed) {
      reportWarning("[supervisor] Failed to parse model output", { scope: "supervisor.parse-failure", usedModel });
      return NextResponse.json(
        { kind: "answer", answer: "No pude procesar tu mensaje. ¿Podés reformularlo?", actions: null, clarification: null, usedModel },
        { status: 200 },
      );
    }

    const guarded = applySupervisorHallucinationGuard(parsed, { businessId: biz.id, usedModel });
    return NextResponse.json({ ...guarded, usedModel } satisfies SupervisorResponse);
  } catch (error) {
    logRouteError("/api/supervisor", error);
    return NextResponse.json({ code: "SUPERVISOR_FAILED", message: "Supervisor could not process the request." }, { status: 500 });
  }
}
