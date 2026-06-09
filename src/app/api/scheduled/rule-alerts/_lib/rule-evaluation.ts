// Per-rule fan-out for the rule-alerts cron. Generates a Companion-tone
// message via Gemini, then writes one ChatMessage + one push per active
// employee for every (rule, slot) pair that matched. Throttled so a
// business with many employees × many rules cannot block the 30-second
// Cloud Scheduler timeout.

import { z } from "zod";
import pLimit from "p-limit";
import { prisma } from "@/lib/prisma";
import { cloudLog } from "@/lib/cloud-logger";
import { getGeminiTextModel } from "@/app/api/business-assistant/_lib/gemini-client";
import { sendPushToEmployee } from "@/app/api/_lib/employee-push";
import type { SlotInstant } from "./cron-matcher";

// Concurrency caps protect a single run from a fan-out spike (e.g. a
// franchise with 50 employees × 10 rules firing in the same 5-min slot).
const CHAT_WRITE_CONCURRENCY = 10;
const PUSH_CONCURRENCY = 5;
// Soft warning threshold; above this we log so ops can split the rule.
export const FAN_OUT_WARNING_THRESHOLD = 1000;

export interface RuleRow {
  id: string;
  businessId: string;
  trigger: string;
  message: string;
}

export interface RuleEvaluationContext {
  rule: RuleRow;
  slot: SlotInstant;
  // Pre-fetched once per rule across all slots in the same run.
  employees: Array<{ id: string; name: string }>;
  template: string;
}

// Zod schema that validates the Gemini-generated template before it reaches
// ChatMessage rendering. Blocks HTML/markdown injection via < > \ characters.
const templateSchema = z
  .string()
  .min(1)
  .max(280)
  .regex(/^[^<>\\]*$/, "contains disallowed characters");

function buildFallback(ruleMessage: string): string {
  return `Che [NOMBRE], recordatorio: ${ruleMessage}`.slice(0, 280);
}

async function generateCompanionTemplate(
  rule: RuleRow,
): Promise<string> {
  const fallback = buildFallback(rule.message);
  try {
    const model = getGeminiTextModel();
    const result = await model.generateContent({
      contents: [{
        role: "user",
        parts: [{
          text: `Convertí esta instrucción del dueño en un mensaje cálido para un empleado. ` +
            `Empezá con "Che [NOMBRE]". Usá cortesía positiva: pedí en forma de solicitud amable, no imperativo. ` +
            `Instrucción: "${rule.message}". ` +
            `Respondé SOLO el texto del mensaje, sin comillas ni markdown, máximo 2 oraciones.`,
        }],
      }],
      generationConfig: { maxOutputTokens: 200, temperature: 0.4 } as never,
    });
    const parts = result.response.candidates?.[0]?.content?.parts ?? [];
    const raw = (
      parts
        .map((p) => p.text)
        .filter((t): t is string => typeof t === "string" && t.length > 0)
        .at(-1) ?? ""
    ).trim();

    const parsed = templateSchema.safeParse(raw);
    if (!parsed.success) {
      cloudLog({
        severity: "WARNING",
        component: "System",
        action: "RULE_TEMPLATE_GEN_FALLBACK",
        a2a_transfer: false,
        message: "Gemini rule template failed validation — using fallback",
        businessId: rule.businessId,
        data: {
          ruleId: rule.id,
          reason: parsed.error.issues[0]?.message ?? "validation_failed",
          rawLength: raw.length,
        },
      });
      return fallback;
    }

    return parsed.data;
  } catch {
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "RULE_TEMPLATE_GEN_FALLBACK",
      a2a_transfer: false,
      message: "Gemini rule template generation threw — using fallback",
      businessId: rule.businessId,
      data: { ruleId: rule.id, reason: "generation_error" },
    });
    return fallback;
  }
}

/**
 * Resolve a rule once per run: fetch active employees and generate the
 * Companion-tone template. Returns null when the rule has no audience.
 */
export async function prepareRule(rule: RuleRow): Promise<{ employees: Array<{ id: string; name: string }>; template: string } | null> {
  const employees = await prisma.employee.findMany({
    where: { businessId: rule.businessId, active: true },
    select: { id: true, name: true },
  });
  if (employees.length === 0) return null;
  const template = await generateCompanionTemplate(rule);
  return { employees, template };
}

interface FireResult {
  fired: number;
  errors: number;
}

/**
 * Write one ChatMessage + send one push per (rule, slot, employee).
 * Idempotency via clientMessageId protects against catch-up overlap. All
 * writes/pushes for a single context run through bounded concurrency.
 */
export async function fireRuleSlot(ctx: RuleEvaluationContext): Promise<FireResult> {
  const { rule, slot, employees, template } = ctx;
  const writeLimit = pLimit(CHAT_WRITE_CONCURRENCY);
  const pushLimit = pLimit(PUSH_CONCURRENCY);
  let fired = 0;
  let errors = 0;

  // Batch dedup: one findMany for all employees in this (rule, slot) instead of
  // N individual findFirst calls. 50 employees × 10 rules × 12 slots = 6000 reads
  // per cron tick without this. With batching it's one read per (rule, slot) pair.
  const allIds = employees.map(
    (emp) => `rule-alert-${rule.id}-${slot.slotKey}-${emp.id}`,
  );
  const existingRows = await prisma.chatMessage.findMany({
    where: { businessId: rule.businessId, clientMessageId: { in: allIds } },
    select: { clientMessageId: true },
  });
  const alreadySent = new Set(existingRows.map((r) => r.clientMessageId));

  await Promise.all(
    employees
      .filter((emp) => !alreadySent.has(`rule-alert-${rule.id}-${slot.slotKey}-${emp.id}`))
      .map((emp) =>
        writeLimit(async () => {
          const clientMessageId = `rule-alert-${rule.id}-${slot.slotKey}-${emp.id}`;
          const alertText = template.replace("[NOMBRE]", emp.name);
          try {
            await prisma.chatMessage.create({
              data: {
                businessId: rule.businessId,
                targetEmployeeId: emp.id,
                clientMessageId,
                kind: "reply",
                source: "manager",
                visibility: "employee_only",
                text: alertText,
              },
            });
            fired += 1;
          } catch (err) {
            errors += 1;
            cloudLog({
              severity: "ERROR",
              component: "System",
              action: "RULE_ALERT_WRITE_FAILED",
              a2a_transfer: false,
              message: "Rule alert chat write failed",
              data: {
                ruleId: rule.id,
                empId: emp.id,
                slotKey: slot.slotKey,
                error: err instanceof Error ? err.message : String(err),
              },
            });
            return;
          }

          await pushLimit(() =>
            sendPushToEmployee(rule.businessId, emp.id, {
              title: "Velora · Recordatorio",
              body: alertText,
              url: "/dashboard",
              notificationCategory: "rule_alert",
              entityId: rule.id,
            }).catch(() => {})
          );
        })
      )
  );

  return { fired, errors };
}

export function logRuleEvaluated(rule: RuleRow, slot: SlotInstant, fired: number, employeeCount: number): void {
  cloudLog({
    severity: "INFO",
    component: "System",
    action: "RULE_ALERTS_RULE_EVALUATED",
    a2a_transfer: false,
    message: "Rule evaluated",
    businessId: rule.businessId,
    data: {
      event: "rule_alerts.rule_evaluated",
      ruleId: rule.id,
      slotKey: slot.slotKey,
      fired,
      employeeCount,
    },
  });
}
