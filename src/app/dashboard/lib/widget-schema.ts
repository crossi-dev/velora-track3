import { z } from "zod";

// Generative-UI widget descriptor — the "component catalog" pattern (Vercel AI
// SDK Generative UI / json-render): the backend emits a typed descriptor and the
// client maps `type` → React component via a registry (WidgetRenderer.tsx).
//
// Mirrors the chips contract (src/app/api/chat-history/_lib/chips-schema.ts):
// duplicated client-side because dashboard code cannot import from /api/*. When
// slice 2 adds the backend emit, the server validator is the source of truth and
// this stays a defensive shape for the client.
//
// Discriminated union keyed by `type` so adding a widget later is trivial:
//   1. add a `<name>WidgetSchema` here and append it to `widgetSchema`'s union,
//   2. add the component to the registry in WidgetRenderer.tsx.

// Shared row-count ceiling so a runaway query can never flood the chat with a
// thousand-row table. Mirrored by the server builder (widget-builder.ts).
export const WIDGET_MAX_ROWS = 12;

// sales_summary — read-only KPI card for a sales period.
export const salesSummaryWidgetSchema = z.object({
  type: z.literal("sales_summary"),
  data: z.object({
    totalARS: z.number(),
    count: z.number().int().nonnegative(),
    topProduct: z.string().nullable(),
    periodLabel: z.string().min(1).max(60),
  }),
});

// stock_table — read-only table of current/low stock (name, qty, price).
export const stockTableWidgetSchema = z.object({
  type: z.literal("stock_table"),
  data: z.object({
    title: z.string().min(1).max(60),
    rows: z
      .array(
        z.object({
          name: z.string().min(1).max(120),
          qty: z.number().int(),
          price: z.number().nonnegative(),
        }),
      )
      .max(WIDGET_MAX_ROWS),
  }),
});

// recent_sales — read-only table of top products by quantity in a period,
// plus the period total in ARS.
export const recentSalesWidgetSchema = z.object({
  type: z.literal("recent_sales"),
  data: z.object({
    periodLabel: z.string().min(1).max(60),
    totalARS: z.number(),
    rows: z
      .array(
        z.object({
          product: z.string().min(1).max(120),
          qtyTotal: z.number().int().nonnegative(),
          amountARS: z.number().nonnegative(),
        }),
      )
      .max(WIDGET_MAX_ROWS),
  }),
});

// Union of every known widget. Append future widget schemas here.
export const widgetSchema = z
  .discriminatedUnion("type", [
    salesSummaryWidgetSchema,
    stockTableWidgetSchema,
    recentSalesWidgetSchema,
  ])
  .nullable()
  .optional();

export type SalesSummaryWidget = z.infer<typeof salesSummaryWidgetSchema>;
export type StockTableWidget = z.infer<typeof stockTableWidgetSchema>;
export type RecentSalesWidget = z.infer<typeof recentSalesWidgetSchema>;

// The descriptor the client renders. The discriminated union infers the full
// `SalesSummaryWidget | StockTableWidget | RecentSalesWidget` automatically.
export type WidgetDescriptor =
  | SalesSummaryWidget
  | StockTableWidget
  | RecentSalesWidget;
