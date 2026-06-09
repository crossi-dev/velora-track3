// Anomaly Scan — cron-triggered escaneo de patrones sospechosos.
// Vive separado de los eventos reactivos (LOW_STOCK, CASH_AT_RISK)
// porque NO depende de un evento específico. Es el supervisor proactivo
// del Mom Test pitch: "el dueño le valora que la IA cuide la caja".
//
// Patrón: stock velocity — productos de alta rotación con stock crítico.
// Escribe un ChatMessage (owner_only, daily severity) para que el Supervisor
// decida si escalar inmediatamente o batchar en el resumen diario.
//
// Protected by CRON_SECRET. Cloud Scheduler lo llama cada 2 horas (schedule: "0 */2 * * *").

import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { cloudLog, runWithTraceContext } from "@/lib/cloud-logger";
import { verifyCronSecret } from "@/app/api/_lib/route-helpers";
import { getArgentinaDateString } from "@/app/dashboard/lib/today-summary";

export const maxDuration = 60;

const STOCK_VELOCITY_WINDOW_DAYS = 7;
const STOCK_VELOCITY_THRESHOLD = 5; // units sold in window to flag fast-moving

interface ScanResult {
  velocityAlertsWritten: number;
  errors: string[];
}

// GET kept for manual/curl verification; POST is the canonical Cloud Scheduler verb.
export async function GET(request: NextRequest) {
  return runWithTraceContext(request.headers, () => handleRequest(request));
}

export async function POST(request: NextRequest) {
  return runWithTraceContext(request.headers, () => handleRequest(request));
}

async function handleRequest(request: NextRequest) {
  const unauth = await verifyCronSecret(request, "anomaly-scan");
  if (unauth) return unauth;

  const result: ScanResult = {
    velocityAlertsWritten: 0,
    errors: [],
  };

  try {
    // ─── Stock velocity scan ─────────────────────────────────────────────────
    // Routes through Supervisor via ChatMessage write (owner_only, daily severity)
    // instead of calling WhatsApp directly — this puts the Supervisor in the loop
    // so it can decide whether to escalate immediately or batch into daily summary.
    // (Fix Q6 H-3: removes direct sendWhatsAppMessage bypass; Fix Q6 H-1: daily wiring)
    const velocityResult = await scanStockVelocityAlerts();
    result.velocityAlertsWritten = velocityResult.written;
    result.errors.push(...velocityResult.errors);

    cloudLog({
      severity: "INFO",
      component: "System",
      action: "ANOMALY_SCAN_COMPLETED",
      a2a_transfer: false,
      message: `Anomaly scan: ${result.velocityAlertsWritten} velocity alert(s) written to chat`,
      data: result as unknown as Record<string, unknown>,
    });

    return NextResponse.json(result);
  } catch (err) {
    cloudLog({
      severity: "ERROR",
      component: "System",
      action: "ANOMALY_SCAN_FAILED",
      a2a_transfer: false,
      message: "Anomaly scan threw an unexpected error",
      data: { error: err instanceof Error ? err.message : String(err) },
    });
    return NextResponse.json(
      { error: "anomaly scan failed", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

// ── Stock velocity: fast-moving products with critically low stock ───────────
// Writes a ChatMessage (owner_only, daily severity) so the Supervisor sees the
// alert in the chat context and can decide to push immediately or batch into the
// daily summary — no more direct WhatsApp bypass (Q6 H-3 + Q6 H-1).

type VelocityRow = {
  productId: string;
  productName: string;
  businessId: string;
  reorderThreshold: number;
  currentStock: number;
  totalSold: number;
};

async function scanStockVelocityAlerts(): Promise<{ written: number; errors: string[] }> {
  const velWindowStart = new Date(Date.now() - STOCK_VELOCITY_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  let rows: VelocityRow[];
  try {
    // Scope to active tenants (had a sale in the last 30 days) to skip idle
    // businesses and keep the JOIN bounded on large datasets.
    // Inner LIMIT 1000 caps the result set — at current scale (single-tenant
    // AR deployment) this is never reached, but it guards against future growth.
    rows = await prisma.$queryRaw<VelocityRow[]>`
      SELECT
        si."productId",
        p.name AS "productName",
        p."businessId",
        p."reorderThreshold",
        p.quantity AS "currentStock",
        SUM(si.quantity)::int AS "totalSold"
      FROM "SaleItem" si
      JOIN "Sale" s ON si."saleId" = s.id
      JOIN "Product" p ON si."productId" = p.id
      WHERE s.date >= ${velWindowStart}
        AND s.status != 'cancelled'
        AND p."businessId" IN (
          SELECT id FROM "Business"
          WHERE id IN (
            SELECT "businessId" FROM "Sale"
            WHERE date >= (NOW() - INTERVAL '30 days')
            LIMIT 1000
          )
        )
      GROUP BY si."productId", p.name, p."businessId", p."reorderThreshold", p.quantity
      HAVING SUM(si.quantity) >= ${Prisma.raw(String(STOCK_VELOCITY_THRESHOLD))}
        AND p.quantity <= p."reorderThreshold"
      LIMIT 1000
    `;
    // ↑ Prisma.raw inlines the numeric constant (safe — module-level const, not user
    // input). Parametrized values inside HAVING/aggregate positions are rejected by
    // Supabase pgbouncer transaction mode (port 6543), causing VELOCITY_QUERY_FAILED.
  } catch (err) {
    cloudLog({
      severity: "ERROR",
      component: "System",
      action: "VELOCITY_QUERY_FAILED",
      a2a_transfer: false,
      message: "Stock velocity SQL query failed",
      data: { error: err instanceof Error ? err.message : String(err) },
    });
    return { written: 0, errors: ["velocity_query_failed"] };
  }

  let written = 0;
  const errors: string[] = [];
  // Use Argentina date string so the dedup key is stable within the AR calendar day,
  // not the UTC day. UTC epoch-day would restart at 21:00 ART, causing duplicate alerts.
  const dayBucket = getArgentinaDateString(Date.now());

  if (rows.length === 0) return { written: 0, errors: [] };

  // Build dedup map: clientMessageId → row (single pass, N=0 DB round-trips).
  const candidateMap = new Map<string, VelocityRow>();
  for (const row of rows) {
    candidateMap.set(`velocity-alert-${row.businessId}-${row.productId}-${dayBucket}`, row);
  }

  // Single query to find all already-written alert IDs — eliminates N+1.
  const alreadyWritten = await prisma.chatMessage.findMany({
    where: { clientMessageId: { in: Array.from(candidateMap.keys()) } },
    select: { clientMessageId: true },
  });
  const seenIds = new Set(alreadyWritten.map((m) => m.clientMessageId));

  for (const [clientMessageId, row] of candidateMap) {
    if (seenIds.has(clientMessageId)) continue;

    const text =
      `Alta rotación detectada: "${row.productName}" — ${row.totalSold} unidades vendidas esta semana con solo ${row.currentStock} en stock. ` +
      `¿Hacemos un pedido al proveedor?`;

    try {
      await prisma.chatMessage.create({
        data: {
          businessId: row.businessId,
          clientMessageId,
          kind: "reply",
          source: "manager",
          visibility: "owner_only",
          text,
        },
      });
      written += 1;
      cloudLog({
        severity: "INFO",
        component: "System",
        action: "VELOCITY_ALERT_CHAT_WRITTEN",
        a2a_transfer: false,
        message: `Stock velocity alert written to chat for product "${row.productName}"`,
        businessId: row.businessId,
        data: { productId: row.productId, totalSold: row.totalSold, currentStock: row.currentStock },
      });
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code === "P2002") {
        // Duplicate — already written by a concurrent scan. Not an error.
        continue;
      }
      errors.push(`vel:${row.businessId}:${row.productId}:${err instanceof Error ? err.message.slice(0, 40) : "err"}`);
    }
  }

  return { written, errors };
}

