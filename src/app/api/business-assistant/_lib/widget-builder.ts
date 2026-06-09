// Generative-UI widget builder (slice 2) — emits a typed, DB-computed widget
// descriptor for OWNER read-only data intents. The descriptor rides alongside
// `chips` in the chat turn response; the client maps `type` → component via
// WidgetRenderer (Vercel AI SDK Generative UI / json-render pattern).
//
// DETERMINISTIC + SAFE BY DESIGN:
//   - Intent is detected by regex on the user text (no LLM).
//   - All numbers are computed from the DB, tenant-scoped by businessId — the
//     LLM never fabricates the widget data.
//   - Read-only: queries only. No mutation path is touched.
//
// Single source of truth: the Zod shapes mirror the CLIENT validator in
// src/app/dashboard/lib/widget-schema.ts. The dashboard cannot import from
// /api/* (build boundary), so this is a defensive server copy. Keep the two in
// sync when adding a widget type.

import { z } from "zod";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { normalizeForMatching } from "./shared";

const MAX_ROWS = 12;

// ── Server-side widget validator (mirrors widget-schema.ts) ─────────────────
const salesSummaryWidgetSchema = z.object({
  type: z.literal("sales_summary"),
  data: z.object({
    totalARS: z.number(),
    count: z.number().int().nonnegative(),
    topProduct: z.string().nullable(),
    periodLabel: z.string().min(1).max(60),
  }),
});

const stockTableWidgetSchema = z.object({
  type: z.literal("stock_table"),
  data: z.object({
    title: z.string().min(1).max(60),
    rows: z
      .array(z.object({ name: z.string().min(1).max(120), qty: z.number().int(), price: z.number().nonnegative() }))
      .max(MAX_ROWS),
  }),
});

const recentSalesWidgetSchema = z.object({
  type: z.literal("recent_sales"),
  data: z.object({
    periodLabel: z.string().min(1).max(60),
    totalARS: z.number(),
    rows: z
      .array(z.object({ product: z.string().min(1).max(120), qtyTotal: z.number().int().nonnegative(), amountARS: z.number().nonnegative() }))
      .max(MAX_ROWS),
  }),
});

export const widgetDescriptorSchema = z.discriminatedUnion("type", [
  salesSummaryWidgetSchema,
  stockTableWidgetSchema,
  recentSalesWidgetSchema,
]);

export type WidgetDescriptor = z.infer<typeof widgetDescriptorSchema>;

// ── Intent detection (deterministic, regex-only) ────────────────────────────
// Sales: "¿cómo van las ventas?", "ventas de hoy", "cuánto vendí", "facturé".
const SALES_QUERY_RE =
  /\b(?:como\s+van\s+las\s+ventas|ventas\s+(?:de\s+)?(?:hoy|la\s+semana|esta\s+semana|del?\s+dia)|cuanto\s+(?:vendi|facture|vendimos)|facturacion|recaude|recaudacion)\b/;
const RECENT_SALES_RE = /\b(?:ultimas?\s+ventas|productos?\s+mas\s+vendidos?|que\s+(?:se\s+)?vendio|mas\s+vendidos?|ranking\s+de\s+ventas)\b/;
const STOCK_QUERY_RE =
  /\b(?:que\s+stock\s+tengo|stock\s+(?:bajo|completo)?|inventario|que\s+tengo\s+(?:en\s+)?stock|productos?\s+con\s+poco\s+stock|que\s+(?:me\s+)?(?:falta|esta\s+por\s+acabarse))\b/;
const WEEK_RE = /\b(?:semana)\b/;
const LOW_STOCK_RE = /\b(?:bajo|poco|falta|acab|agot)\b/;

type WidgetKind = "sales_summary" | "stock_table" | "recent_sales" | null;

function detectWidgetKind(normalizedText: string): WidgetKind {
  if (RECENT_SALES_RE.test(normalizedText)) return "recent_sales";
  if (SALES_QUERY_RE.test(normalizedText)) return "sales_summary";
  if (STOCK_QUERY_RE.test(normalizedText)) return "stock_table";
  return null;
}

// ── Period helpers (ART-naive: server runs UTC; "hoy/semana" computed in UTC) ─
function periodStart(normalizedText: string): { since: Date; label: string } {
  const now = new Date();
  if (WEEK_RE.test(normalizedText)) {
    const since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    return { since, label: "Últimos 7 días" };
  }
  const since = new Date(now);
  since.setHours(0, 0, 0, 0);
  return { since, label: "Hoy" };
}

function toNum(v: { toNumber?: () => number } | number | string | null | undefined): number {
  if (v == null) return 0;
  if (typeof v === "number") return v;
  if (typeof v === "string") return Number(v) || 0;
  if (typeof v.toNumber === "function") return v.toNumber();
  return 0;
}

// ── Data builders ───────────────────────────────────────────────────────────
async function buildSalesSummary(businessId: string, normalizedText: string): Promise<WidgetDescriptor> {
  const { since, label } = periodStart(normalizedText);
  const sales = await prisma.sale.findMany({
    where: { businessId, date: { gte: since } },
    select: { totalAmount: true, saleItems: { select: { quantity: true, product: { select: { name: true } } } } },
  });

  let totalARS = 0;
  const qtyByProduct = new Map<string, number>();
  for (const s of sales) {
    totalARS += toNum(s.totalAmount);
    for (const it of s.saleItems) {
      const name = it.product?.name;
      if (!name) continue;
      qtyByProduct.set(name, (qtyByProduct.get(name) ?? 0) + it.quantity);
    }
  }
  let topProduct: string | null = null;
  let topQty = 0;
  for (const [name, qty] of qtyByProduct) {
    if (qty > topQty) {
      topQty = qty;
      topProduct = name;
    }
  }

  return { type: "sales_summary", data: { totalARS, count: sales.length, topProduct, periodLabel: label } };
}

async function buildRecentSales(businessId: string, normalizedText: string): Promise<WidgetDescriptor> {
  const { since, label } = periodStart(normalizedText);
  const sales = await prisma.sale.findMany({
    where: { businessId, date: { gte: since } },
    select: { totalAmount: true, saleItems: { select: { quantity: true, unitPrice: true, product: { select: { name: true } } } } },
  });

  let totalARS = 0;
  const agg = new Map<string, { qty: number; amount: number }>();
  for (const s of sales) {
    totalARS += toNum(s.totalAmount);
    for (const it of s.saleItems) {
      const name = it.product?.name;
      if (!name) continue;
      const prev = agg.get(name) ?? { qty: 0, amount: 0 };
      prev.qty += it.quantity;
      prev.amount += it.quantity * toNum(it.unitPrice);
      agg.set(name, prev);
    }
  }
  const rows = [...agg.entries()]
    .map(([product, v]) => ({ product, qtyTotal: v.qty, amountARS: v.amount }))
    .sort((a, b) => b.qtyTotal - a.qtyTotal)
    .slice(0, MAX_ROWS);

  return { type: "recent_sales", data: { periodLabel: label, totalARS, rows } };
}

async function buildStockTable(businessId: string, normalizedText: string): Promise<WidgetDescriptor> {
  const lowStock = LOW_STOCK_RE.test(normalizedText);
  // Low-stock view sorts ascending and keeps the leanest items; full view shows
  // the current catalog (capped at MAX_ROWS). Tenant-scoped by businessId.
  const products = await prisma.product.findMany({
    where: { businessId, ...(lowStock ? { quantity: { lte: 5 } } : {}) },
    select: { name: true, quantity: true, price: true },
    orderBy: lowStock ? { quantity: "asc" } : { name: "asc" },
    take: MAX_ROWS,
  });

  const rows = products.map((p) => ({ name: p.name, qty: p.quantity, price: toNum(p.price) }));
  const title = lowStock ? "Stock bajo" : "Stock actual";
  return { type: "stock_table", data: { title, rows } };
}

// ── Public entry point ──────────────────────────────────────────────────────
/**
 * Builds a widget descriptor for an OWNER read-only data intent, or null if the
 * text doesn't match a known read intent. Computes all data from the DB,
 * tenant-scoped by businessId. Fail-open: any error returns null (the chat turn
 * still renders its text answer without a widget).
 */
export async function buildWidgetForReadIntent(args: {
  text: string;
  businessId: string;
}): Promise<WidgetDescriptor | null> {
  const normalized = normalizeForMatching(args.text);
  const kind = detectWidgetKind(normalized);
  if (!kind) return null;

  try {
    let descriptor: WidgetDescriptor;
    if (kind === "sales_summary") descriptor = await buildSalesSummary(args.businessId, normalized);
    else if (kind === "recent_sales") descriptor = await buildRecentSales(args.businessId, normalized);
    else descriptor = await buildStockTable(args.businessId, normalized);

    // Stock table with zero rows carries no signal — skip it.
    if (descriptor.type === "stock_table" && descriptor.data.rows.length === 0) return null;

    const parsed = widgetDescriptorSchema.safeParse(descriptor);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Response-assembly seam: for an OWNER 2xx turn with a text answer, compute a
 * read-intent widget, attach it to the body, then hand the (possibly new)
 * response + body to `finalise` (the route's finalisePost). When nothing should
 * change (not owner, non-2xx, no answer, no match) the original response + body
 * pass through untouched. Never throws — buildWidgetForReadIntent is fail-open.
 *
 * Both the LLM path (respond) and the deterministic fast-path (cacheAndReturn)
 * call this so every owner read intent renders a widget.
 */
export async function attachOwnerReadWidget(args: {
  body: Record<string, unknown>;
  response: NextResponse;
  status: number;
  role: string;
  businessId: string;
  text: string;
  finalise: (response: NextResponse, body: Record<string, unknown>, status: number) => Promise<NextResponse>;
}): Promise<NextResponse> {
  const { body, response, status, role, businessId, text, finalise } = args;
  const passthrough =
    role !== "owner" || !(status >= 200 && status < 300) || typeof body.answer !== "string" || !body.answer;
  if (passthrough) return finalise(response, body, status);

  const widget = await buildWidgetForReadIntent({ text, businessId });
  if (!widget) return finalise(response, body, status);

  const nextBody = { ...body, widget };
  return finalise(NextResponse.json(nextBody, { status }), nextBody, status);
}
