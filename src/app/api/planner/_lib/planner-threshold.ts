import { prisma } from "@/lib/prisma";
import { cloudLog } from "@/lib/cloud-logger";
import { recordPostCommitFailure } from "@/app/api/_lib/post-commit-failure-tracker";
import { normalizeProductName } from "./planner-normalize";
import { parseTrigger } from "./rule-trigger-parser";

// Velora Manager (Agent 2) — post-sale threshold trigger.
// Called fire-and-forget from sales/create after a sale completes.
// For each product that crossed below its reorder threshold in the sale,
// writes one Manager ChatMessage. Deduplicated to one alert per product
// per calendar day via the clientMessageId unique constraint.

interface ThresholdAlert {
  productId: string;
  productName: string;
  remainingUnits: number;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

export async function checkThresholdCrossings(
  businessId: string,
  alerts: ThresholdAlert[],
): Promise<number> {
  if (alerts.length === 0) return 0;
  const date = new Date().toISOString().slice(0, 10);
  let written = 0;

  // Load all active condition-based stock_below rules once to avoid N+1 queries.
  // condition-stock-rules.ts is canonical for products covered by a BusinessRule —
  // suppress planner-threshold for those to avoid dual alerts in the owner feed.
  const conditionRules = await prisma.businessRule.findMany({
    where: { businessId, active: true, kind: "condition-based", trigger: { startsWith: "stock_below:" } },
    select: { trigger: true },
  }).catch(() => [] as { trigger: string }[]);
  const coveredProductNames = new Set(
    conditionRules.flatMap((r) => {
      const parsed = parseTrigger(r.trigger);
      return parsed ? [normalizeProductName(parsed.name)] : [];
    })
  );

  for (const alert of alerts) {
    // Skip if a condition-based rule already covers this product (condition-stock-rules.ts fires instead).
    if (coveredProductNames.has(normalizeProductName(alert.productName))) continue;
    const slug = slugify(alert.productName);
    if (!slug) continue;
    const clientMessageId = `planner-threshold-${alert.productId}-${date}`;
    const text = `📦 Alerta automática de stock\n${alert.productName} cruzó el umbral. Quedan ${alert.remainingUnits}u. — buen momento para reponer.`;

    try {
      await prisma.chatMessage.create({
        data: { businessId, clientMessageId, kind: "reply", source: "manager", visibility: "owner_only", text },
      });
      written++;
      cloudLog({
        severity: "INFO",
        component: "System",
        action: "PLANNER_THRESHOLD_ALERT_WRITTEN",
        a2a_transfer: false,
        message: "planner threshold alert written to owner chat",
        businessId,
        data: { productId: alert.productId, productName: alert.productName, remainingUnits: alert.remainingUnits },
      });
    } catch (error: unknown) {
      // P2002 = unique constraint violation → already alerted today, skip silently.
      const code = (error as { code?: string } | null)?.code;
      if (code !== "P2002") {
        const errorMessage = error instanceof Error ? error.message : String(error);
        cloudLog({ severity: "ERROR", component: "System", action: "PLANNER_THRESHOLD_WRITE_FAILED", a2a_transfer: false, message: "planner threshold ChatMessage write failed", businessId, data: { productName: alert.productName, error: errorMessage } });
        void recordPostCommitFailure({ businessId, action: "PLANNER_THRESHOLD_WRITE_FAILED", errorMessage: `${alert.productName}: ${errorMessage}` });
      }
    }
  }

  return written;
}
