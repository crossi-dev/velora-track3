// Velora Agent Contract — runtime helpers for the A2A v0.3.0 event bus.
//
// Wire format por A2A `message/send`:
//   - parts[0] = { kind: "text", text: <human summary>  }
//   - parts[1] = { kind: "data", data: <EmployeeEvent>  }
//
// Types live in @/domain/events. This module only ships runtime logic so it
// can be imported from server routes without pulling in domain-model deps.

export type {
  EmployeeEventType,
  EmployeeEventBase,
  LowStockEvent,
  ShiftStartEvent,
  ShiftEndEvent,
  CashAtRiskEvent,
  BulkImportCompletedEvent,
  ChatMessageEvent,
  CompanionResponseEvent,
  SupervisorQueryEvent,
  StockIngressRequestEvent,
  EmployeeEvent,
} from "@/domain/events";

export { EMPLOYEE_EVENT_PROTOCOL } from "@/domain/events";

import type { EmployeeEvent } from "@/domain/events";
import { employeeEventSchema } from "./event-schemas";

export function formatEventTextSummary(ev: EmployeeEvent): string {
  switch (ev.type) {
    case "LOW_STOCK": {
      const items = ev.alerts.map((a) => `${a.productName} (${a.remainingUnits}/${a.reorderThreshold})`).join(", ");
      return `LOW_STOCK saleId=${ev.saleId} items=[${items}]`;
    }
    case "SHIFT_START":
      return `SHIFT_START employeeId=${ev.actorEmployeeId} at=${ev.loginAt}`;
    case "SHIFT_END":
      return `SHIFT_END employeeId=${ev.actorEmployeeId} duration=${ev.durationMinutes}min`;
    case "CASH_AT_RISK":
      return `CASH_AT_RISK employeeId=${ev.actorEmployeeId} pattern=${ev.pattern} count=${ev.count} window=${ev.windowMinutes}min total=${ev.totalAmount}`;
    case "BULK_IMPORT_COMPLETED":
      return `BULK_IMPORT_COMPLETED resource=${ev.resource} inserted=${ev.inserted} updated=${ev.updated} skipped=${ev.skipped} file=${ev.fileName}`;
    case "CHAT_MESSAGE": {
      const preview = ev.text.length > 60 ? `${ev.text.slice(0, 60)}…` : ev.text;
      return `CHAT_MESSAGE actor=${ev.actorRole} text="${preview}"`;
    }
    case "COMPANION_RESPONSE":
      return `COMPANION_RESPONSE intent=${ev.safeIntent} clarif=${ev.requiresClarification} actions=[${ev.actionsEmitted.join(",")}]`;
    case "SUPERVISOR_QUERY":
      return `SUPERVISOR_QUERY kind=${ev.escalationKind} inReplyTo=${ev.inReplyToEventId}`;
    case "STOCK_INGRESS_REQUEST": {
      const items = ev.items.map((i) => `${i.productName} x${i.quantity}`).join(", ");
      return `STOCK_LOAD_REQUEST items=[${items}] total=${ev.totalEstimatedValue} maxTicket=${ev.maxIngressTicket} supplier=${ev.supplierName ?? "N/A"}`;
    }
  }
}

export function parseEmployeeEvent(raw: unknown): EmployeeEvent | null {
  const result = employeeEventSchema.safeParse(raw);
  if (!result.success) return null;
  return result.data;
}
