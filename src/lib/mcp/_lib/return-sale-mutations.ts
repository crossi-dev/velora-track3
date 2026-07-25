// src/lib/mcp/_lib/return-sale-mutations.ts — Handler for the return_sale MCP tool.
//
// Reuses undoSaleBatchInTransaction (src/app/api/undo/_lib/undo-sale.ts) — the same
// battle-tested transaction that the /api/undo route uses. No new undo logic is written.
//
// Audit contract (mirrors undo route):
//   - recordCriticalWriteEvent is called INSIDE the Prisma transaction (same as undo route).
//   - On any inner throw the whole tx rolls back — including the audit row — so no partial
//     undo with a dangling audit record can occur.
//
// Idempotency contract:
//   - Key is derived server-side: (businessId, "return_sale", count, cutoffHours).
//   - Caller-supplied idempotencyKey is intentionally IGNORED — per caja/MCP convention.
//   - idempotency.begin + complete are called around the transaction via prismaIdempotencyAdapter.
//
// SECURITY: businessId ALWAYS from the closure — NEVER from tool input.
// saleId not accepted — return_sale targets the N most-recent sales inside the cutoff
// window, exactly like /api/undo. This prevents callers from specifying arbitrary sale IDs
// from other tenants.
//
// References:
//   undoSaleBatchInTransaction — src/app/api/undo/_lib/undo-sale.ts
//   prismaIdempotencyAdapter  — src/infrastructure/persistence/prisma-idempotency.adapter.ts
//   getServerActionMeta       — src/app/api/_lib/mutation-contract.ts
//   SERVER_MUTATION_CONTRACT  — src/app/api/_lib/mutation-contract-entries.ts ("undo.execute")

import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { prismaIdempotencyAdapter } from "@/infrastructure/persistence/prisma-idempotency.adapter";
import { getServerActionMeta } from "@/app/api/_lib/mutation-contract";
import { undoSaleBatchInTransaction } from "@/app/api/undo/_lib/undo-sale";
import { createHash } from "crypto";
import { errResponse } from "./mcp-responses";

// ── Action meta ───────────────────────────────────────────────────────────────

// Reuses undo.execute — canonical actionType for all undo/return operations.
const UNDO_EXECUTE_ACTION = getServerActionMeta("undo.execute");

// ── MCP actor constant ────────────────────────────────────────────────────────

const MCP_ACTOR_USER_ID = "mcp-system";

// ── Idempotency key ────────────────────────────────────────────────────────────

function buildReturnSaleIdemKey(businessId: string, saleIds: string[]): string {
  // Key the operation to the SPECIFIC sales being reversed (sorted for determinism),
  // NOT a coarse count/hour bucket. A genuine retry of the same reversal dedupes;
  // two different return operations in the same hour never collide. The old
  // hour-bucket key silently swallowed a second distinct return within the hour.
  // Brandur idempotency-keys: a key must identify one logical operation.
  const raw = `${businessId}|return_sale|${[...saleIds].sort().join(",")}`;
  return "mcp-return-" + createHash("sha256").update(raw).digest("hex").slice(0, 24);
}

// ── Tool response type ─────────────────────────────────────────────────────────

type McpToolResponse = { content: { type: "text"; text: string }[]; isError?: boolean };

// ── handleReturnSale ──────────────────────────────────────────────────────────

export interface ReturnSaleArgs {
  count: number;
  cutoffHours: number;
}

/**
 * Reverses the N most-recent sales within the cutoffHours window for the tenant.
 *
 * Mirrors the /api/undo route's "sale" target:
 *   1. Look up the N most-recent sales within the cutoff window.
 *   2. Check for protected invoices (sent/paid) — abort if any found.
 *   3. Run undoSaleBatchInTransaction inside a Prisma $transaction:
 *      - Restores inventory.
 *      - Deletes StockMovement / SaleItem / Invoice / Sale / CashMovement rows.
 *      - Invalidates idempotency records for those sales.
 *      - Writes audit rows INSIDE the same transaction.
 *      - Completes the idempotency record for this return_sale call.
 *   4. Fires best-effort WPP refund notification (fire-and-forget, after commit).
 */
export async function handleReturnSale(
  businessId: string,
  args: ReturnSaleArgs,
): Promise<McpToolResponse> {
  const { count, cutoffHours } = args;
  const safeCount = Math.min(count, 10);
  const cutoffMs = cutoffHours * 60 * 60 * 1000;
  const undoCutoff = new Date(Date.now() - cutoffMs);

  // Fetch the candidate sales BEFORE the idempotency claim so the key can be tied
  // to the SPECIFIC sales being reversed (these reads are side-effect-free).
  const [sales, business] = await Promise.all([
    prisma.sale.findMany({
      where: { businessId, date: { gte: undoCutoff } },
      orderBy: { date: "desc" },
      take: safeCount,
      select: {
        id: true,
        date: true,
        totalAmount: true,
        customer: { select: { name: true, phone: true } },
        saleItems: { select: { productId: true, quantity: true } },
      },
    }),
    prisma.business.findUnique({
      where: { id: businessId },
      select: { name: true },
    }),
  ]);

  if (sales.length === 0) {
    return errResponse("NO_RECENT_SALES", `No sales found in the last ${cutoffHours} hour(s) to return.`);
  }

  const saleIds = sales.map((s) => s.id);

  const idemKey = buildReturnSaleIdemKey(businessId, saleIds);

  const idempotency = await prismaIdempotencyAdapter.begin({
    businessId,
    actionType: UNDO_EXECUTE_ACTION.actionType,
    idempotencyKey: idemKey,
    requestBody: { target: "sale", saleIds },
  });

  if (idempotency.kind === "replay") {
    return { content: [{ type: "text" as const, text: JSON.stringify(idempotency.body) }] };
  }
  if (idempotency.kind === "conflict") {
    return errResponse("IDEMPOTENCY_CONFLICT", "Idempotency key conflict — different body for same key.");
  }
  if (idempotency.kind === "in_flight") {
    return errResponse("IDEMPOTENCY_IN_FLIGHT", "Concurrent operation in progress — retry later.");
  }
  if (idempotency.kind !== "execute") {
    // "missing" or any future unknown kind
    return errResponse("IDEMPOTENCY_CONFLICT", "Idempotency check failed — retry later.");
  }

  const idempotencyRecordId = idempotency.recordId;

  try {

    const INVOICE_LOCKED = "INVOICE_LOCKED:";
    let result: Awaited<ReturnType<typeof undoSaleBatchInTransaction>>;
    try {
      result = await prisma.$transaction(async (tx) => {
        // tenant-scope-ok: saleIds are pre-filtered by businessId in the sale.findMany above
        const protectedInvoices = await tx.invoice.findMany({
          where: { saleId: { in: saleIds }, status: { in: ["sent", "paid"] } },
          select: { saleId: true, invoiceNumber: true, status: true },
        });
        if (protectedInvoices.length > 0) {
          const nums = protectedInvoices.map((i) => i.invoiceNumber).join(", ");
          const verb = protectedInvoices[0].status === "paid" ? "paid" : "sent";
          throw new Error(`${INVOICE_LOCKED}${verb}|${nums}`);
        }

        return undoSaleBatchInTransaction(tx as unknown as Prisma.TransactionClient, {
          businessId,
          userId: MCP_ACTOR_USER_ID,
          routeScope: UNDO_EXECUTE_ACTION.routeScope,
          sales,
          idempotencyRecordId,
        });
      });
    } catch (err) {
      if (err instanceof Error && err.message.startsWith(INVOICE_LOCKED)) {
        const [, rest] = err.message.split(INVOICE_LOCKED);
        const [verb, nums] = (rest ?? "|").split("|");
        await prismaIdempotencyAdapter.release(idempotencyRecordId);
        return errResponse("INVOICE_LOCKED", `Cannot return: invoice ${nums} has already been ${verb}.`);
      }
      throw err;
    }

    // Best-effort WPP refund notification — fire-and-forget after commit.
    void (async () => {
      const { sendCustomerRefundNotification } = await import(
        "@/app/api/agents/communications/jsonrpc/_lib/handle-communications-rpc"
      );
      const businessName = business?.name ?? "";
      for (const sale of sales) {
        const phone = sale.customer?.phone ?? null;
        if (!phone) continue;
        // The Sale row was hard-deleted inside the transaction above (undo-sale.ts),
        // so a post-commit CAS on Sale.undoNotificationSentAt would always match 0
        // rows (Prisma updateMany returns {count:0} on no-match, not an error —
        // prisma.io/docs/orm/reference/prisma-client-reference#updatemany) and skip
        // every refund WhatsApp. Concurrent duplicate returns are already prevented
        // by the undo idempotency record, so notify directly.
        await sendCustomerRefundNotification({
          businessId,
          customerPhone: phone,
          customerName: sale.customer?.name ?? null,
          businessName,
          amount: Number(sale.totalAmount),
          reason: "undo_sale",
          referenceId: sale.id,
        });
      }
    })();

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({ returned: sales.length, summary: result.labels }),
      }],
    };
  } catch (err) {
    await prismaIdempotencyAdapter.release(idempotencyRecordId);
    return errResponse("RETURN_SALE_ERROR", err instanceof Error ? err.message : "Unknown error");
  }
}
