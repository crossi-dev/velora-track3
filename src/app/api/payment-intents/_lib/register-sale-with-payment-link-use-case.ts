// register-sale-with-payment-link-use-case.ts — Atomic Sale + Invoice + PaymentIntent
// for the Checkout Pro / payment-link flow.
//
// Product invariant: "nunca hay link de pago sin venta."
// A PaymentIntent for a Checkout Pro link MUST have a real Sale row so that
// downstream code (fiscal agent, PDF renderer, comprobante) always has a Sale
// with SaleItems and an Invoice — no standalone/null-saleId paths.
//
// Industry-standard grounding:
//   [1] Brandur / Stripe canonical 2026 — write Sale + ledger row atomically in
//       the DB FIRST, THEN call the external payment provider. If the provider
//       call fails, the local state has a record that can be retried safely.
//       See: https://brandur.org/idempotency-keys
//            https://github.com/brandur/rocket-rides-atomic
//   [2] MercadoPago Preference 2026 — external_reference maps 1:1 to a pre-existing
//       seller order (Sale.id) identified in the seller's DB before the preference is
//       created. See: https://www.mercadopago.com.ar/developers/en/reference/preferences/_checkout_preferences/post
//   [3] Outbox / atomic-phase pattern (Saga + Outbox 2026) — local DB state MUST be
//       committed before any irreversible foreign-state mutation (MP preference creation).
//       See: https://appscale.blog/en/blog/microservices-pattern-combo-saga-outbox-2026
//   [4] NABAOS arXiv 2603.10060 — every monetary value must trace to a DB row or
//       tool output; LLM-inferred numbers must never reach a payment provider.
//   [5] AFIP/ARCA RG 4291 + COMPG v4.1 — Invoice DB row created at sale time;
//       CAE obtained asynchronously by fiscal agent post-payment confirm.
//       See: https://www.afip.gob.ar/fe/documentos/manual-desarrollador-ARCA-COMPG-v4-0.pdf
//
// Transaction body extracted to register-sale-with-payment-link.transaction.ts
// to keep both files under the 300-line server/api hard limit.

import type { InputJsonValue } from "@prisma/client/runtime/library";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { lineTotal, money, roundMoney } from "@/lib/money";
import { cloudLog } from "@/lib/cloud-logger";
import { recordCriticalWriteEvent } from "@/infrastructure/shared/critical-write-audit";
import { getServerActionMeta } from "@/app/api/_lib/mutation-contract";
import {
  beginIdempotentMutation,
  completeIdempotentMutation,
  releaseIdempotentMutation,
} from "@/app/api/_lib/idempotency";
import { runSaleWithPaymentLinkTransaction } from "./register-sale-with-payment-link.transaction";

const ACTION_META = getServerActionMeta("payment_intent.create_link");

// ---------------------------------------------------------------------------
// Public interface (STABLE — parallel agents depend on this exact shape)
// ---------------------------------------------------------------------------

export interface RegisterSaleWithPaymentLinkInput {
  businessId: string;
  actorUserId: string;
  actorEmployeeId?: string | null;
  customerId: string;
  items: Array<{
    productId: string;
    quantity: number;
    unitPriceOverride?: number;
  }>;
  /** Title passed downstream to the MP Preference. Not stored on the PI row. */
  description: string;
  /** Idempotency key derived upstream (e.g. buildLinkIdempotencyKey). */
  idempotencyKey: string;
  shippingRequired?: boolean;
  shippingAddress?: InputJsonValue | null;
  shippingCostARS?: number | null;
  shippingCourier?: "andreani" | "oca" | null;
}

export type RegisterSaleWithPaymentLinkResult =
  | { outcome: "created"; paymentIntentId: string; saleId: string; grandTotal: number }
  | { outcome: "replayed"; paymentIntentId: string; saleId: string }
  | { outcome: "customer_not_found" }
  | { outcome: "product_not_found"; productId: string }
  | { outcome: "wrong_business"; productId: string }
  | { outcome: "invalid_qty"; productId: string }
  | { outcome: "unit_price_out_of_range"; productId: string }
  | { outcome: "insufficient_stock"; productName: string; available: number }
  | { outcome: "business_not_found" }
  | { outcome: "invalid_total" }
  | { outcome: "idempotency_missing" }
  | { outcome: "idempotency_conflict" }
  | { outcome: "idempotency_in_flight" };

// ---------------------------------------------------------------------------
// P2002 guard (no instanceof needed)
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

export async function registerSaleWithPaymentLinkUseCase(
  input: RegisterSaleWithPaymentLinkInput,
): Promise<RegisterSaleWithPaymentLinkResult> {
  const {
    businessId, actorUserId, customerId, items, idempotencyKey, description,
    shippingRequired, shippingAddress, shippingCostARS, shippingCourier,
  } = input;
  const now = new Date();

  // ── Idempotency guard — beginIdempotentMutation (insert-first strategy) ─────
  // Brandur [1]: unique index is the authoritative arbiter; two concurrent callers
  // can both reach this point — only one insert wins; loser gets conflict/in_flight.
  const guard = await beginIdempotentMutation({
    client: prisma,
    businessId,
    actionType: ACTION_META.actionType,
    idempotencyKey,
    requestBody: { customerId, items, description },
  });

  if (guard.kind === "missing") return { outcome: "idempotency_missing" };
  if (guard.kind === "conflict") return { outcome: "idempotency_conflict" };
  if (guard.kind === "in_flight") return { outcome: "idempotency_in_flight" };
  if (guard.kind === "replay") {
    // Completed run replayed — read back PI for stable ids.
    const prior = await prisma.paymentIntent.findFirst({
      where: { businessId, idempotencyKey },
      select: { id: true, saleId: true },
    });
    cloudLog({ severity: "INFO", component: "A2A", action: "REGISTER_SALE_WITH_LINK_REPLAYED", a2a_transfer: false, message: "registerSaleWithPaymentLinkUseCase: idempotent replay", businessId, data: { paymentIntentId: prior?.id, idempotencyKey } });
    return { outcome: "replayed", paymentIntentId: prior?.id ?? "", saleId: prior?.saleId ?? "" };
  }

  const { recordId } = guard; // kind === "execute"

  // ── Tenant-scoped lookup: customer ────────────────────────────────────────
  const customer = await prisma.customer.findFirst({
    where: { id: customerId, businessId },
    select: { id: true, name: true, email: true, phone: true, taxId: true, dni: true, address: true, postalCode: true, city: true },
  });
  if (!customer) {
    await releaseIdempotentMutation({ client: prisma, recordId });
    return { outcome: "customer_not_found" };
  }

  // ── Tenant-scoped lookup: products ────────────────────────────────────────
  const productIds = items.map((i) => i.productId);
  const products = await prisma.product.findMany({
    where: { id: { in: productIds }, businessId },
    select: { id: true, name: true, price: true, businessId: true, quantity: true },
  });
  const productMap = new Map(products.map((p) => [p.id, p]));

  for (const item of items) {
    const product = productMap.get(item.productId);
    if (!product) {
      await releaseIdempotentMutation({ client: prisma, recordId });
      return { outcome: "product_not_found", productId: item.productId };
    }
    if (product.businessId !== businessId) {
      await releaseIdempotentMutation({ client: prisma, recordId });
      return { outcome: "wrong_business", productId: item.productId };
    }
    if (!Number.isInteger(item.quantity) || item.quantity <= 0) {
      await releaseIdempotentMutation({ client: prisma, recordId });
      return { outcome: "invalid_qty", productId: item.productId };
    }
  }

  // ── Pre-check: unitPriceOverride plausibility (NABAOS M2) ────────────────
  // Reject before the items loop — throwing inside .map() is awkward.
  // <10× override: accepted (real discounts / negotiated prices pass through).
  // ≥10× override: REJECT — silently charging a different amount than discussed
  //   is worse than refusing. Release idempotency record; caller must correct.
  for (const item of items) {
    const rawOverride = typeof item.unitPriceOverride === "number" && Number.isFinite(item.unitPriceOverride)
      ? item.unitPriceOverride
      : undefined;
    if (rawOverride !== undefined) {
      const dbPrice = Number(productMap.get(item.productId)!.price);
      if (rawOverride > dbPrice * 10) {
        await releaseIdempotentMutation({ client: prisma, recordId });
        cloudLog({ severity: "WARNING", component: "A2A", action: "SALE_WITH_LINK_UNIT_PRICE_OUT_OF_RANGE", a2a_transfer: false, message: "unitPriceOverride exceeded 10× dbPrice — rejected (NABAOS M2)", businessId, data: { productId: item.productId, dbPrice, override: rawOverride } });
        return { outcome: "unit_price_out_of_range", productId: item.productId };
      }
    }
  }

  // ── Resolve prices from DB (NABAOS [4]: no LLM-inferred numbers) ──────────
  const resolvedItems = items.map((item) => {
    const product = productMap.get(item.productId)!;
    const dbPrice = Number(product.price);
    const rawOverride = typeof item.unitPriceOverride === "number" && Number.isFinite(item.unitPriceOverride)
      ? item.unitPriceOverride
      : undefined;
    const unitPrice = rawOverride !== undefined ? rawOverride : dbPrice;
    if (rawOverride !== undefined && rawOverride !== dbPrice) {
      cloudLog({ severity: "INFO", component: "A2A", action: "SALE_WITH_LINK_UNIT_PRICE_OVERRIDDEN", a2a_transfer: false, message: "unitPriceOverride disagrees with product.price from DB (NABAOS audit)", businessId, data: { productId: item.productId, dbPrice, override: rawOverride } });
    }
    // Per-line rounding model (Dynamics 365 "Calculation method = Line"):
    // lineTotal() rounds each line to 2dp ROUND_HALF_UP independently.
    // Source: https://learn.microsoft.com/en-us/dynamics365/finance/localizations/global/tax-calculation-rounding-rules (VERIFIED HTTP 200)
    const lineTotalValue = lineTotal(item.quantity, unitPrice).toNumber();
    return { productId: item.productId, productName: product.name, quantity: item.quantity, unitPrice, lineTotal: lineTotalValue };
  });

  // itemsSubtotal: sum of already-2dp line totals — no second round.
  // sum(lineTotal per item) guarantees invoice lines == header total.
  const itemsSubtotal = resolvedItems.reduce(
    (acc, i) => acc.plus(money(i.lineTotal)), money(0)
  ).toNumber();
  const shippingCost = shippingCostARS ?? 0;
  // grandTotal: exact Decimal add of subtotal + shipping, rounded to 2dp.
  const grandTotal = roundMoney(money(itemsSubtotal).plus(money(shippingCost))).toNumber();

  // ── Pre-commit total guard — prevents orphan PaymentIntent rows ───────────
  // Brandur [1]: validate ALL inputs before the first irreversible DB write.
  // grandTotal must be finite and > 0. A zero/NaN total here means a DB price
  // of 0 or a Prisma Decimal that failed Number() conversion — both are data
  // integrity failures that must not reach the transaction or the MP provider.
  // The idempotency record is already open ("in_flight"); release it so the
  // caller can retry after the data problem is corrected.
  if (!Number.isFinite(grandTotal) || grandTotal <= 0) {
    await releaseIdempotentMutation({ client: prisma, recordId });
    cloudLog({ severity: "ERROR", component: "A2A", action: "REGISTER_SALE_WITH_LINK_INVALID_TOTAL", a2a_transfer: false, message: "grandTotal is not a positive finite number — aborting before DB write", businessId, data: { grandTotal, itemsSubtotal, shippingCost, items } });
    return { outcome: "invalid_total" };
  }

  // ── Atomic transaction — see .transaction.ts for full body ────────────────
  // [3] Outbox/atomic-phase: all DB state committed BEFORE calling MP preference API.
  let txResult: { sale: { id: string }; invoice: { id: string }; pi: { id: string } };
  try {
    txResult = await prisma.$transaction(async (txRaw) => {
      const tx = txRaw as unknown as Prisma.TransactionClient;
      return runSaleWithPaymentLinkTransaction(tx, {
        businessId, customer, resolvedItems, grandTotal,
        shippingCost, shippingRequired: shippingRequired ?? false,
        shippingAddress: shippingAddress ?? null,
        shippingCourier: shippingCourier ?? null,
        idempotencyKey, now,
        productMap: new Map(products.map((p) => [p.id, { quantity: p.quantity, name: p.name }])),
      });
    });
  } catch (err) {
    await releaseIdempotentMutation({ client: prisma, recordId });
    // ── P2002 on PI @@unique([businessId, idempotencyKey]) — belt-and-suspenders ─
    // beginIdempotentMutation guards against most races; P2002 here catches any
    // remaining TOCTOU window at the PI insert level.
    if (isP2002OnIdempotencyKey(err)) {
      const raced = await prisma.paymentIntent.findFirst({ where: { businessId, idempotencyKey }, select: { id: true, saleId: true } });
      cloudLog({ severity: "INFO", component: "A2A", action: "REGISTER_SALE_WITH_LINK_REPLAYED_VIA_P2002", a2a_transfer: false, message: "TOCTOU race resolved via P2002 readback", businessId, data: { paymentIntentId: raced?.id, idempotencyKey } });
      return { outcome: "replayed", paymentIntentId: raced?.id ?? "", saleId: raced?.saleId ?? "" };
    }
    const tagged = err as { tag?: string };
    if (tagged.tag === "BUSINESS_NOT_FOUND") return { outcome: "business_not_found" };
    const message = err instanceof Error ? err.message : String(err);
    if (message === "INSUFFICIENT_STOCK") {
      const typed = err as { productName?: string; available?: number };
      return { outcome: "insufficient_stock", productName: typed.productName ?? "unknown", available: typed.available ?? 0 };
    }
    throw err;
  }

  // ── Complete idempotency record ───────────────────────────────────────────
  await completeIdempotentMutation({
    client: prisma,
    recordId,
    responseStatus: 200,
    responseBody: { outcome: "created", paymentIntentId: txResult.pi.id, saleId: txResult.sale.id, grandTotal },
  });

  // ── Audit write — best-effort (G #2) ─────────────────────────────────────
  try {
    await recordCriticalWriteEvent({
      client: prisma, businessId, actorUserId,
      routeScope: ACTION_META.routeScope, actionType: ACTION_META.actionType,
      resourceType: ACTION_META.resourceType, resourceId: txResult.pi.id,
      summary: `Link de pago MP — ${customer.name} — $${grandTotal}${shippingCost > 0 ? ` (envío $${shippingCost})` : ""}`,
      payload: { paymentIntentId: txResult.pi.id, saleId: txResult.sale.id, invoiceId: txResult.invoice.id, customerId: customer.id, grandTotal, itemsSubtotal, shippingCostARS: shippingCost > 0 ? shippingCost : null, shippingCourier: shippingCourier ?? null, idempotencyKey },
    });
  } catch (auditErr) {
    cloudLog({ severity: "WARNING", component: "A2A", action: "REGISTER_SALE_WITH_LINK_AUDIT_WRITE_FAILED", a2a_transfer: false, message: "recordCriticalWriteEvent failed after transaction commit — sale committed, audit row missed", businessId, data: { paymentIntentId: txResult.pi.id, error: auditErr instanceof Error ? auditErr.message : String(auditErr) } });
  }

  cloudLog({ severity: "INFO", component: "A2A", action: "REGISTER_SALE_WITH_LINK_CREATED", a2a_transfer: false, message: `created PI ${txResult.pi.id} with Sale ${txResult.sale.id}`, businessId, data: { paymentIntentId: txResult.pi.id, saleId: txResult.sale.id, grandTotal } });

  return { outcome: "created", paymentIntentId: txResult.pi.id, saleId: txResult.sale.id, grandTotal };
}
