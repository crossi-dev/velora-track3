"use client";

import type { WidgetDescriptor } from "../../lib/types";
import { SalesSummaryWidget } from "./SalesSummaryWidget";
import { StockTableWidget } from "./StockTableWidget";
import { RecentSalesWidget } from "./RecentSalesWidget";

// Generative-UI widget renderer — the registry that maps a widget descriptor's
// `type` to its React component (Vercel AI SDK Generative UI / json-render
// pattern). The backend emits a typed descriptor; the client owns rendering.
//
// To add a widget type later: add the schema to widget-schema.ts, then add one
// entry below. Unknown types render nothing (defensive — never crash the chat on
// a descriptor the client doesn't know yet, e.g. an older app build).
//
// Slice-2 demo shape — a backend turn response would carry, alongside `chips`:
//   widget: {
//     type: "sales_summary",
//     data: { totalARS: 184500, count: 23, topProduct: "Coca 500ml", periodLabel: "Hoy" },
//   }

// Registry keyed by descriptor `type`. Each component receives the narrowed
// descriptor for its own type (the discriminated union guarantees the match).
const WIDGET_REGISTRY = {
  sales_summary: SalesSummaryWidget,
  stock_table: StockTableWidget,
  recent_sales: RecentSalesWidget,
} as const;

export function WidgetRenderer({ widget }: { widget: WidgetDescriptor }) {
  switch (widget.type) {
    case "sales_summary":
      return <WIDGET_REGISTRY.sales_summary descriptor={widget} />;
    case "stock_table":
      return <WIDGET_REGISTRY.stock_table descriptor={widget} />;
    case "recent_sales":
      return <WIDGET_REGISTRY.recent_sales descriptor={widget} />;
    default:
      // Unknown widget type — render nothing rather than crash. The exhaustive
      // switch also makes the compiler flag any new union member added without a
      // matching case here.
      return null;
  }
}
