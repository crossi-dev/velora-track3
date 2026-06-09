// register-promesa-sale-use-case.ts — One-shot Sale + Invoice + PaymentIntent (promesa).
//
// Industry-standard grounding pattern (Stripe / Google ADK 2026 / NABAOS arXiv 2603.10060):
//   - All monetary values are resolved from DB rows, NOT from LLM input.
//   - unitPriceOverride is accepted only when explicitly provided by the tool caller;
//     DB price is always the default.
//   - Invoice.payloadJson snapshot is built from DB rows — immutable after creation.
//   - Idempotency: idempotencyKey stored on PaymentIntent (@@unique [businessId, key]).

import { createHash } from "crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { lineTotal, money, roundMoney } from "@/lib/money";
import { cloudLog } from "@/lib/cloud-logger";
import { recordCriticalWriteEvent } from "@/infrastructure/shared/critical-write-audit";
import { getServerActionMeta } from "@/app/api/_lib/mutation-contract";
import { runPostConfirmSideEffects } from "./payment-intent-post-confirm";
import { runPromesaSaleTransaction } from "./register-promesa-sale.transaction";

const ACTION_META = getServerActionMeta("payment_intent.register_promesa_sale");

// Public types live in ./register-promesa-sale-use-case.types (extracted for the
// 300-line size contract) and are re-exported here so importers keep their path.
import type { RegisterPromesaSaleItem, RegisterPromesaSaleShipping, RegisterPromesaSaleInput, RegisterPromesaSaleResult } from "./register-promesa-sale-use-case.types";
export type { RegisterPromesaSaleItem, RegisterPromesaSaleShipping, RegisterPromesaSaleInput, RegisterPromesaSaleResult };

// ---------------------------------------------------------------------------
// Idempotency key derivation — deterministic, stable on LLM retries
// ---------------------------------------------------------------------------

function buildIdempotencyKey(
  customerId: string,
  items: RegisterPromesaSaleItem[],
  expectedAt: Date,
): string {
  // Sort items so [A, B] and [B, A] produce the same key.
  const canonical = [...items]
    .sort((a, b) => a.productId.localeCompare(b.productId))
    .map((i) => `${i.productId}:${i.quantity}:${i.unitPriceOverride ?? ""}`)
    .join("|");
  const raw = `${customerId}|${canonical}|${expectedAt.toISOString()}`;
  return "promesa-sale-" + createHash("sha256").update(raw).digest("hex").slice(0, 24);
}

// ---------------------------------------------------------------------------
// P2002 guard — structural check (no instanceof needed; avoids type-import issue)
// Matches the pattern in prisma-product.repository.ts and disconnect-use-case.ts.
// ---------------------------------------------------------------------------

function isP2002OnIdempotencyKey(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = "code" in err ? (err as { code?: unknown }).code : undefined;
  if (code !== "P2002") return false;
  const meta = "meta" in err ? (err as { meta?: { target?: unknown } }).meta : undefined;
  const target = meta?.target ?? "";
  if (Array.isArray(target)) return target.includes("idempotencyKey");
  return String(target).includes("idempotencyKey");
}

// ---------------------------------------------------------------------------
// Use-case
// ---------------------------------------------------------------------------

export async function registerPromesaSaleUseCase(
  input: RegisterPromesaSaleInput,
): Promise<RegisterPromesaSaleResult> {
  const { businessId, actorUserId, customerId, items, expectedAt, reason, shipping } = input;
  const now = new Date();
  const idempotencyKey = buildIdempotencyKey(customerId, items, expectedAt);

  // ── Idempotency guard — fast path (pre-check, non-racing duplicates) ───────
  // The DB @@unique([businessId, idempotencyKey]) is the AUTHORITATIVE dedup.
  // This findFirst is an optimisation only — two concurrent calls can both read
  // null, enter $transaction, and the second writer hits P2002 (handled below).
  const existing = await prisma.paymentIntent.findFirst({
    where: { businessId, idempotencyKey },
    select: { id: true, saleId: true },
  });
  if (existing) {
    cloudLog({
      severity: "INFO",
      component: "A2A",
      action: "REGISTER_PROMESA_SALE_REPLAYED",
      a2a_transfer: false,
      message: "registerPromesaSaleUseCase: idempotent replay",
      businessId,
      data: { paymentIntentId: existing.id, idempotencyKey },
    });
    return { outcome: "replayed", paymentIntentId: existing.id, saleId: existing.saleId ?? "" };
  }

  // ── Tenant-scoped lookup: customer ────────────────────────────────────────
  const customer = await prisma.customer.findFirst({
    where: { id: customerId, businessId },
    select: { id: true, name: true, email: true, phone: true, taxId: true, dni: true, address: true, postalCode: true, city: true },
  });
  if (!customer) return { outcome: "customer_not_found" };

  // ── Tenant-scoped lookup: products ────────────────────────────────────────
  const productIds = items.map((i) => i.productId);
  const products = await prisma.product.findMany({
    where: { id: { in: productIds }, businessId },
    select: { id: true, name: true, price: true, businessId: true, quantity: true },
  });
  const productMap = new Map(products.map((p) => [p.id, p]));

  // Validate every item against DB before touching anything.
  for (const item of items) {
    const product = productMap.get(item.productId);
    if (!product) return { outcome: "product_not_found", productId: item.productId };
    if (product.businessId !== businessId) return { outcome: "wrong_business", productId: item.productId };
    if (!Number.isInteger(item.quantity) || item.quantity <= 0) {
      return { outcome: "invalid_qty", productId: item.productId };
    }
  }

  // ── Pre-check: unitPriceOverride > 10× dbPrice → REJECT (NABAOS M2). ─────
  // Silently clamping is worse than refusing; caller must correct and retry.
  for (const item of items) {
    const ro = typeof item.unitPriceOverride === "number" && Number.isFinite(item.unitPriceOverride) ? item.unitPriceOverride : undefined;
    if (ro !== undefined && ro > Number(productMap.get(item.productId)!.price) * 10) {
      cloudLog({ severity: "WARNING", component: "A2A", action: "PROMESA_SALE_UNIT_PRICE_OUT_OF_RANGE", a2a_transfer: false, message: "unitPriceOverride exceeded 10× dbPrice — rejected (NABAOS M2)", businessId, data: { productId: item.productId, override: ro } });
      return { outcome: "unit_price_out_of_range", productId: item.productId };
    }
  }

  // ── Resolve prices from DB (NABAOS invariant: no LLM-inferred numbers) ────
  const resolvedItems = items.map((item) => {
    const product = productMap.get(item.productId)!;
    const dbPrice = Number(product.price);
    const rawOverride = typeof item.unitPriceOverride === "number" && Number.isFinite(item.unitPriceOverride)
      ? item.unitPriceOverride
      : undefined;
    const unitPrice = rawOverride !== undefined ? rawOverride : dbPrice;
    if (rawOverride !== undefined && rawOverride !== dbPrice) {
      cloudLog({ severity: "INFO", component: "A2A", action: "PROMESA_SALE_UNIT_PRICE_OVERRIDDEN", a2a_transfer: false, message: "unitPriceOverride disagrees with product.price from DB (NABAOS audit)", businessId, data: { productId: item.productId, dbPrice, override: rawOverride } });
    }
    // Per-line decimal.js rounding (mirrors the sibling payment-link path) — never raw float for money.
    return { productId: item.productId, productName: product.name, quantity: item.quantity, unitPrice, lineTotal: lineTotal(item.quantity, unitPrice).toNumber() };
  });

  const itemsSubtotal = resolvedItems.reduce((acc, i) => acc.plus(money(i.lineTotal)), money(0)).toNumber();
  const shippingCost = shipping?.cost ?? 0;
  const grandTotal = roundMoney(money(itemsSubtotal).plus(money(shippingCost))).toNumber();
  // Pre-commit total guard (mirrors sibling payment-link path): a payment amount must be positive (Stripe https://docs.stripe.com/api/payment_intents/create); a $0/NaN total (price-0 product) must not reach the money ledger.
  if (!Number.isFinite(grandTotal) || grandTotal <= 0) {
    cloudLog({ severity: "ERROR", component: "A2A", action: "REGISTER_PROMESA_INVALID_TOTAL", a2a_transfer: false, message: "grandTotal is not a positive finite number — aborting before DB write", businessId, data: { grandTotal, itemsSubtotal, shippingCost } });
    return { outcome: "invalid_total" };
  }
  const expectedDateStr = expectedAt.toISOString().slice(0, 10);

  // ── Atomic transaction (Sale + SaleItems + inventory + Invoice + CashMovement + PI) ──
  let txResult: { createdSale: { id: string }; createdInvoice: { id: string }; createdPI: { id: string } };
  try {
    // Cast to Prisma.TransactionClient — same pattern as prisma-sale.repository.ts.
    txResult = await prisma.$transaction(async (txRaw) => {
      const tx = txRaw as unknown as Prisma.TransactionClient;
      return runPromesaSaleTransaction(tx, {
        businessId, customer, resolvedItems, grandTotal, now,
        expectedAt, expectedDateStr, reason, idempotencyKey,
        shipping: shipping ?? null,
        productMap: new Map(products.map((p) => [p.id, { quantity: p.quantity, name: p.name }])),
      });
    });
  } catch (err) {
    // ── P2002 on @@unique([businessId, idempotencyKey]) — TOCTOU race resolved ──
    // Stripe/industry standard 2026: the DB unique constraint is the AUTHORITATIVE
    // dedup. Two concurrent calls can both pass the fast-path findFirst and race
    // inside $transaction — second writer hits P2002. Readback to return the
    // committed record as a normal replayed outcome (not an error).
    if (isP2002OnIdempotencyKey(err)) {
      const raced = await prisma.paymentIntent.findFirst({
        where: { businessId, idempotencyKey },
        select: { id: true, saleId: true },
      });
      cloudLog({
        severity: "INFO",
        component: "A2A",
        action: "REGISTER_PROMESA_SALE_REPLAYED_VIA_P2002",
        a2a_transfer: false,
        message: "registerPromesaSaleUseCase: TOCTOU race resolved via P2002 readback",
        businessId,
        data: { paymentIntentId: raced?.id, idempotencyKey },
      });
      return {
        outcome: "replayed",
        paymentIntentId: raced?.id ?? "",
        saleId: raced?.saleId ?? "",
      };
    }

    // ── BUSINESS_NOT_FOUND thrown inside transaction (tagged error) ───────────
    const tagged = err as { tag?: string };
    if (tagged.tag === "BUSINESS_NOT_FOUND") {
      return { outcome: "business_not_found" };
    }

    // ── INSUFFICIENT_STOCK thrown inside transaction ──────────────────────────
    const message = err instanceof Error ? err.message : String(err);
    if (message === "INSUFFICIENT_STOCK") {
      const typed = err as { productName?: string; available?: number };
      return {
        outcome: "insufficient_stock",
        productName: typed.productName ?? "unknown",
        available: typed.available ?? 0,
      };
    }
    throw err;
  }

  // ── Post-transaction side effects (fire-and-forget) ───────────────────────
  // Now that saleId + sale.invoice.payloadJson exist on the PI, runPostConfirmSideEffects
  // resolves the PDF path inside notifyCustomerOnConfirm (pdfAttached=true).
  runPostConfirmSideEffects(txResult.createdPI.id, businessId).catch(() => {
    // Errors are logged inside runPostConfirmSideEffects.
  });

  // ── Audit write — best-effort (G #2) ─────────────────────────────────────
  // If recordCriticalWriteEvent throws AFTER the transaction has committed,
  // the sale already exists in the DB and we must NOT fail the tool call.
  // The CriticalWriteEvent cron provides fallback recovery for missed audit rows.
  try {
    await recordCriticalWriteEvent({
      client: prisma,
      businessId,
      actorUserId,
      routeScope: ACTION_META.routeScope,
      actionType: ACTION_META.actionType,
      resourceType: ACTION_META.resourceType,
      resourceId: txResult.createdPI.id,
      summary: `Promesa one-shot — ${customer.name} — vence ${expectedDateStr} — $${grandTotal}${shipping ? ` (envío ${shipping.courier} $${shipping.cost})` : ""}`,
      payload: {
        paymentIntentId: txResult.createdPI.id,
        saleId: txResult.createdSale.id,
        invoiceId: txResult.createdInvoice.id,
        customerId: customer.id,
        grandTotal,
        itemsSubtotal,
        shippingCost: shipping?.cost ?? null,
        shippingCourier: shipping?.courier ?? null,
        expectedAt: expectedAt.toISOString(),
        reason: reason ?? null,
        idempotencyKey,
      },
    });
  } catch (auditErr) {
    cloudLog({
      severity: "WARNING",
      component: "A2A",
      action: "REGISTER_PROMESA_SALE_AUDIT_WRITE_FAILED",
      a2a_transfer: false,
      message: "recordCriticalWriteEvent failed after transaction commit — sale committed, audit row missed",
      businessId,
      data: {
        paymentIntentId: txResult.createdPI.id,
        error: auditErr instanceof Error ? auditErr.message : String(auditErr),
      },
    });
  }

  cloudLog({
    severity: "INFO",
    component: "A2A",
    action: "REGISTER_PROMESA_SALE_CREATED",
    a2a_transfer: false,
    message: `registerPromesaSaleUseCase: created PI ${txResult.createdPI.id}`,
    businessId,
    data: { paymentIntentId: txResult.createdPI.id, saleId: txResult.createdSale.id, grandTotal, expectedAt: expectedAt.toISOString() },
  });

  return { outcome: "created", paymentIntentId: txResult.createdPI.id, saleId: txResult.createdSale.id, grandTotal };
}
