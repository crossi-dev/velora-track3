// stock-aviso-draft.ts — Autonomous purchase draft trigger.
//
// When the Companion receives a report_event with eventType === "stock_aviso"
// AND the product's current stock is 0, this module:
//   1. Creates a PurchaseRequest draft in the DB.
//   2. Sends a push notification to the owner.
//   3. Returns a flag so the caller can append the notification sentence.
//
// Called fire-and-forget from employee-handler.ts. Never throws.

import { randomUUID } from "crypto";
import { prisma } from "@/lib/prisma";
import { cloudLog, reportWarning } from "@/lib/cloud-logger";
import { sendPushToOwner } from "./owner-push";
import { nextBusinessCounter } from "@/infrastructure/shared/business-counter";

export interface StockAvisoDraftArgs {
  businessId: string;
  productName: string;
  productId: string;
  reorderThreshold: number;
  supplierId: string | null;
  businessCurrency: string;
}

export interface StockAvisoDraftResult {
  drafted: boolean;
  requestNumber: string | null;
  pushSent: number;
}

const DEFAULT_DRAFT_QUANTITY = 10;
const DRAFT_PREFIX = "DRAFT-";

/** Increments the "purchase-request" BusinessCounter and returns the new value. */
async function nextDraftSequence(businessId: string): Promise<number> {
  return nextBusinessCounter(prisma, businessId, "purchase-request");
}

/** Writes the PurchaseRequest draft row and returns the requestNumber. */
async function persistDraftRow(args: {
  businessId: string;
  productId: string;
  productName: string;
  supplierId: string | null;
  supplierName: string | null;
  quantity: number;
  currency: string;
}): Promise<string> {
  const requestId = randomUUID().replace(/-/g, "");
  const issuedAt = new Date();
  const seqNum = await nextDraftSequence(args.businessId);
  const requestNumber = `${DRAFT_PREFIX}${String(seqNum).padStart(6, "0")}`;

  const payloadJson = JSON.stringify({
    draft: true,
    productId: args.productId,
    productName: args.productName,
    quantity: args.quantity,
    supplierId: args.supplierId,
    supplierName: args.supplierName,
    triggeredBy: "stock_aviso_zero",
  });

  await prisma.purchaseRequest.create({
    data: {
      id: requestId,
      businessId: args.businessId,
      supplierId: args.supplierId,
      requestNumber,
      issuedAt,
      currency: args.currency,
      totalAmount: 0,
      payloadJson,
      createdAt: issuedAt,
    },
  });

  return requestNumber;
}

function logDraftError(businessId: string, productName: string, err: unknown): void {
  reportWarning("[stock-aviso-draft] draft creation failed", { scope: "stock-aviso-draft", businessId, productName, error: err instanceof Error ? err.message : String(err) });
  cloudLog({
    severity: "ERROR",
    component: "Supervisor",
    action: "STOCK_AVISO_DRAFT_FAILED",
    a2a_transfer: false,
    message: "Auto-draft purchase request creation failed",
    businessId,
    data: { productName, error: err instanceof Error ? err.message : String(err) },
  });
}

/**
 * Creates a PurchaseRequest draft when stock hits 0 on a stock_aviso event.
 * Always resolves — never throws. On error returns { drafted: false }.
 */
export async function createStockAvisoDraft(
  args: StockAvisoDraftArgs,
): Promise<StockAvisoDraftResult> {
  try {
    const quantity = Math.max(DEFAULT_DRAFT_QUANTITY, args.reorderThreshold * 2);
    // RLS-verify audit: compound where with args.businessId — OWASP secure-by-default tenant isolation.
    // args.businessId is already in scope. Use findFirst (no @@unique on [id, businessId]).
    const supplier = args.supplierId
      ? await prisma.supplier.findFirst({ where: { id: args.supplierId, businessId: args.businessId }, select: { name: true } })
      : null;

    const requestNumber = await persistDraftRow({
      businessId: args.businessId,
      productId: args.productId,
      productName: args.productName,
      supplierId: args.supplierId,
      supplierName: supplier?.name ?? null,
      quantity,
      currency: args.businessCurrency,
    });

    cloudLog({
      severity: "INFO",
      component: "Supervisor",
      action: "STOCK_AVISO_DRAFT_CREATED",
      a2a_transfer: false,
      message: `Auto-draft ${requestNumber} created for ${args.productName} (stock=0)`,
      businessId: args.businessId,
      data: { requestNumber, productId: args.productId, quantity },
    });

    const fan = await sendPushToOwner(args.businessId, {
      title: "Velora · Stock agotado",
      body: `${args.productName} llegó a 0. Ya armé el borrador ${requestNumber} para que lo aprobés.`,
      url: "/dashboard",
      notificationCategory: "anomaly",
      entityId: requestNumber,
    });

    return { drafted: true, requestNumber, pushSent: fan.sent };
  } catch (err) {
    logDraftError(args.businessId, args.productName, err);
    return { drafted: false, requestNumber: null, pushSent: 0 };
  }
}
