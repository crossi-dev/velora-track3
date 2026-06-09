import { prisma } from "@/lib/prisma";
import { cloudLog } from "@/lib/cloud-logger";
import { sendPushToOwner } from "@/app/api/_lib/owner-push";
import { normalizeProductName } from "./planner-normalize";
import { getArgentinaDateString } from "@/app/dashboard/lib/today-summary";
import { parseTrigger } from "./rule-trigger-parser";

interface StockAlert { productName: string; remainingUnits: number; }

/**
 * After a sale, evaluates condition-based BusinessRules with stock_below triggers.
 * Writes an owner_only ChatMessage for each matching rule, deduped per rule per day.
 * Never throws.
 */
export async function evaluateConditionBasedRules(
  businessId: string,
  alerts: StockAlert[],
): Promise<void> {
  if (alerts.length === 0) return;
  const rules = await prisma.businessRule.findMany({
    where: { businessId, active: true, kind: "condition-based", trigger: { startsWith: "stock_below:" } },
    select: { id: true, trigger: true, message: true },
  }).catch(() => []);

  if (rules.length === 0) return;

  // Use Argentina date — UTC date would break daily dedup at 21:00 ART (UTC midnight).
  const date = getArgentinaDateString(Date.now());

  for (const rule of rules) {
    const parsed = parseTrigger(rule.trigger);
    if (!parsed) continue;

    const normalizedRuleName = normalizeProductName(parsed.name);
    const matched = alerts.find(
      (a) => normalizeProductName(a.productName) === normalizedRuleName && a.remainingUnits <= parsed.threshold,
    );
    if (!matched) continue;

    const clientMessageId = `condition-rule-${rule.id}-${date}`;
    try {
      await prisma.chatMessage.create({
        data: { businessId, clientMessageId, kind: "reply", source: "manager", visibility: "owner_only", text: `📋 Tu regla activada\n${rule.message}` },
      });
      void sendPushToOwner(businessId, {
        title: `Velora · Alerta de stock`,
        body: `Te aviso: ${matched.productName} bajó del umbral. ${rule.message}`,
        url: "/dashboard",
        notificationCategory: "rule_alert",
        entityId: `${rule.id}:${date}`,
      }).catch(() => {
        // Best-effort — push failure must not block the chat nudge already written.
      });
    } catch (error: unknown) {
      const code = (error as { code?: string } | null)?.code;
      if (code !== "P2002") {
        cloudLog({ severity: "ERROR", component: "System", action: "CONDITION_RULE_WRITE_FAILED", a2a_transfer: false, message: "Condition rule alert write failed", businessId, data: { ruleId: rule.id, error: error instanceof Error ? error.message : String(error) } });
      }
    }
  }
}
