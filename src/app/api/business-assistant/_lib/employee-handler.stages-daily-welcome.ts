// Once-per-day proactive Companion greeting — in-session, server-side, employee chat path only.
//
// Fires at most once per calendar day (ART timezone) when a GRADUATED employee
// (onboarding complete) opens the chat with an empty or bare-greeting message.
// The Companion greets them by name, surfaces the active business rules set by
// the owner, and briefly lists what it can help with.
//
// Idempotency: Employee.lastWelcomeAt is stamped on the first fire. The
// once-per-day check reads that field (no ChatMessage sentinel needed).
//
// Guard: fires ONLY when ctx.params.text is empty or a bare greeting.
// Any substantive message (e.g. "vendí 3 lattes") returns null immediately
// so the real message flows through the normal pipeline unchanged.
//
// First-time guard: fires only when onboarding is complete
// (Employee.onboardingCompletedAt is set). The first-time onboarding flow
// (employee-welcome.ts) owns all interactions until graduation.
//
// NO Cloud Scheduler. NO Web Push. Purely in-session.

import { prisma } from "@/lib/prisma";
import { cloudLog } from "@/lib/cloud-logger";
import { getActiveBusinessRules } from "./active-rules-selector";
import type { PipelineStage } from "./employee-handler.ctx";
import { getArgentinaDateString, getArgentinaDayStart } from "@/lib/argentina-date";

// Derive both the date string ("YYYY-MM-DD") and the start-of-day Date from a
// single base timestamp so there is no ~6-second window at UTC midnight where
// the two could disagree. Uses Intl-based helpers (DST-safe).
function artDateParts(now: Date): { dateStr: string; dayStart: Date } {
  const ms = now.getTime();
  return {
    dateStr: getArgentinaDateString(ms),
    dayStart: new Date(getArgentinaDayStart(ms)),
  };
}

// Bare-greeting words that do NOT count as substantive messages.
// Mirrors the same regex in owner-handler.stages-daily-nudge.ts.
// Exported for unit-testing.
const GREETING_RE =
  /^\s*(hola|buen[ao]s?(\s+(d[ií]as?|noches?|tardes?))?|buen\s+d[ií]a|buenas|hey|hi|ey|good\s+(morning|afternoon|evening))\s*[!¡.]*\s*$/i;

/**
 * Returns true when `text` is empty, blank, or a bare greeting — i.e. the
 * employee opened the chat without asking anything specific. Exported so unit
 * tests can verify the guard without importing the full pipeline stage.
 */
export function isGreetingOrEmpty(text: string): boolean {
  if (!text || !text.trim()) return true;
  return GREETING_RE.test(text.trim());
}

// Build a short human-readable summary of the active business rules.
// Returns null when there are no active rules (greeting still fires without
// the rules block so the employee always gets a warm welcome).
function buildRulesSummary(
  rules: { message: string }[],
): string | null {
  if (rules.length === 0) return null;
  // Surface up to 2 rules so the greeting stays short.
  const items = rules.slice(0, 2).map((r) => r.message);
  if (items.length === 1) return `Recordá: ${items[0]}.`;
  return `Recordá: ${items.join(" · ")}.`;
}

// Stamp Employee.lastWelcomeAt. Returns true on success (first write today);
// false when already stamped today or on DB error.
async function tryMarkWelcomeSent(employeeId: string, dayStart: Date): Promise<boolean> {
  try {
    // Only update if the field is still null or before today's ART day start.
    const result = await prisma.employee.updateMany({
      where: {
        id: employeeId,
        OR: [
          { lastWelcomeAt: null },
          { lastWelcomeAt: { lt: dayStart } },
        ],
      },
      data: { lastWelcomeAt: new Date() },
    });
    return result.count > 0;
  } catch (error) {
    cloudLog({
      severity: "WARNING",
      component: "Employee",
      action: "DAILY_WELCOME_STAMP_FAILED",
      a2a_transfer: false,
      message: "Could not stamp Employee.lastWelcomeAt; skipping daily welcome",
      businessId: "", // filled by caller via cloudLog if needed
      data: { employeeId, error: error instanceof Error ? error.message : String(error) },
    });
    return false;
  }
}

// Persist the greeting as a real assistant ChatMessage so it appears in chat
// history like any other Companion message. clientMessageId is stable per
// employee+date so concurrent requests are idempotent (P2002 → skip silently).
async function persistWelcomeMessage(
  businessId: string,
  employeeId: string,
  welcomeText: string,
  artDateStr: string,
): Promise<void> {
  const clientMessageId = `companion-daily-welcome-${employeeId}-${artDateStr}`;
  try {
    await prisma.chatMessage.create({
      data: {
        businessId,
        clientMessageId,
        kind: "reply",
        source: "assistant",
        visibility: "employee_only",
        text: welcomeText,
        // Link the message to this specific employee so it appears in their
        // feed and not in the owner's chat.
        targetEmployeeId: employeeId,
      },
    });
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (code === "P2002") return; // Race — already persisted, harmless.
    cloudLog({
      severity: "WARNING",
      component: "Employee",
      action: "DAILY_WELCOME_PERSIST_FAILED",
      a2a_transfer: false,
      message: "Could not persist Companion daily welcome ChatMessage",
      businessId,
      data: { employeeId, error: error instanceof Error ? error.message : String(error) },
    });
  }
}

// The pipeline stage itself.
export const employeeDailyWelcomeStage: PipelineStage = {
  name: "employeeDailyWelcome",
  run: async (ctx) => {
    const { text, businessId, actorEmployeeId, actorUserId, respond, trace, latency } =
      ctx.params;

    // CRITICAL guard: only intercept empty or greeting-like turns.
    // Any substantive message must flow through the normal pipeline unchanged.
    if (!isGreetingOrEmpty(text)) return null;

    // Only runs for authenticated employees.
    if (!actorEmployeeId) return null;

    latency.start("preModel");

    // Load employee: check onboarding gate + lastWelcomeAt + name in one query.
    const emp = await prisma.employee.findUnique({
      where: { id: actorEmployeeId },
      select: {
        name: true,
        onboardingCompletedAt: true,
        lastWelcomeAt: true,
      },
    });

    if (!emp) {
      latency.end("preModel");
      return null;
    }

    // First-time guard: the onboarding flow (employee-welcome.ts) owns all
    // interactions until graduation. Daily welcome only fires post-graduation.
    if (!emp.onboardingCompletedAt) {
      latency.end("preModel");
      return null;
    }

    const now = new Date();
    const { dateStr: artDateStr, dayStart } = artDateParts(now);

    // Once-per-day check via Employee.lastWelcomeAt.
    if (emp.lastWelcomeAt && emp.lastWelcomeAt >= dayStart) {
      latency.end("preModel");
      return null;
    }

    // Attempt to stamp — concurrent requests handled by updateMany predicate.
    const didWrite = await tryMarkWelcomeSent(actorEmployeeId, dayStart);
    latency.end("preModel");

    if (!didWrite) return null;

    // Fetch active business rules for this business (lightweight, capped at 5).
    const rules = await getActiveBusinessRules(businessId).catch(() => []);
    const rulesSummary = buildRulesSummary(rules);

    // Build the greeting.
    const rulesPart = rulesSummary ? ` ${rulesSummary}` : "";
    const welcomeText =
      `Buen día, ${emp.name}.${rulesPart} ` +
      "Podés decirme: registrar una venta, consultar stock, hacer una nota de gasto, o pedir un pedido al proveedor. " +
      "Estoy acá.";

    trace.add("routing", "employee → daily-welcome (proactive)");
    latency.setMeta("path", "employee-daily-welcome");
    latency.emit({ businessId, actorUserId, actorEmployeeId });

    cloudLog({
      severity: "INFO",
      component: "Employee",
      action: "COMPANION_DAILY_WELCOME_SENT",
      a2a_transfer: false,
      message: "Proactive daily welcome fired",
      businessId,
      data: { employeeId: actorEmployeeId, artDateStr, rulesCount: rules.length },
    });

    // Persist as a real assistant message so it appears in chat history.
    void persistWelcomeMessage(businessId, actorEmployeeId, welcomeText, artDateStr).catch(
      () => { /* best-effort */ },
    );

    return respond({
      answer: welcomeText,
      actions: [],
    });
  },
};
