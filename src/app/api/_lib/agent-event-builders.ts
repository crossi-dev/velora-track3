// Constructors — typed builders que sales/create + futuros emitters usan.
// Pure functions: solo arman el objeto EmployeeEvent. La publicación al
// supervisor (round-trip o audit-only) vive en `agent-events.ts` y los
// wrappers de alto nivel en `agent-event-publishers.ts`.

import { randomUUID } from "crypto";
import {
  EMPLOYEE_EVENT_PROTOCOL,
  type LowStockEvent,
  type CashAtRiskEvent,
  type BulkImportCompletedEvent,
  type ChatMessageEvent,
  type CompanionResponseEvent,
  type SupervisorQueryEvent,
  type StockIngressRequestEvent,
} from "@/lib/agent-contract";

export function buildLowStockEvent(args: {
  businessId: string;
  actorEmployeeId: string | null;
  saleId: string;
  alerts: LowStockEvent["alerts"];
}): LowStockEvent {
  return {
    protocol: EMPLOYEE_EVENT_PROTOCOL.name,
    protocolVersion: EMPLOYEE_EVENT_PROTOCOL.version,
    eventId: randomUUID(),
    emittedAt: new Date().toISOString(),
    type: "LOW_STOCK",
    businessId: args.businessId,
    actorEmployeeId: args.actorEmployeeId,
    saleId: args.saleId,
    alerts: args.alerts,
  };
}

export function buildCashAtRiskEvent(args: {
  businessId: string;
  actorEmployeeId: string;
  pattern: CashAtRiskEvent["pattern"];
  count: number;
  windowMinutes: number;
  totalAmount: number;
}): CashAtRiskEvent {
  return {
    protocol: EMPLOYEE_EVENT_PROTOCOL.name,
    protocolVersion: EMPLOYEE_EVENT_PROTOCOL.version,
    eventId: randomUUID(),
    emittedAt: new Date().toISOString(),
    type: "CASH_AT_RISK",
    businessId: args.businessId,
    actorEmployeeId: args.actorEmployeeId,
    pattern: args.pattern,
    count: args.count,
    windowMinutes: args.windowMinutes,
    totalAmount: args.totalAmount,
  };
}

export function buildBulkImportCompletedEvent(args: {
  businessId: string;
  actorEmployeeId: string | null;
  resource: string;
  inserted: number;
  updated: number;
  skipped: number;
  fileName: string;
}): BulkImportCompletedEvent {
  return {
    protocol: EMPLOYEE_EVENT_PROTOCOL.name,
    protocolVersion: EMPLOYEE_EVENT_PROTOCOL.version,
    eventId: randomUUID(),
    emittedAt: new Date().toISOString(),
    type: "BULK_IMPORT_COMPLETED",
    businessId: args.businessId,
    actorEmployeeId: args.actorEmployeeId,
    resource: args.resource,
    inserted: args.inserted,
    updated: args.updated,
    skipped: args.skipped,
    fileName: args.fileName,
  };
}

export function buildChatMessageEvent(args: {
  businessId: string;
  actorEmployeeId: string | null;
  text: string;
  locale: string | null;
  actorRole: "owner" | "employee";
  clientMessageId: string | null;
}): ChatMessageEvent {
  return {
    protocol: EMPLOYEE_EVENT_PROTOCOL.name,
    protocolVersion: EMPLOYEE_EVENT_PROTOCOL.version,
    eventId: randomUUID(),
    emittedAt: new Date().toISOString(),
    type: "CHAT_MESSAGE",
    businessId: args.businessId,
    actorEmployeeId: args.actorEmployeeId,
    text: args.text.slice(0, 500),
    locale: args.locale,
    actorRole: args.actorRole,
    clientMessageId: args.clientMessageId,
  };
}

export function buildCompanionResponseEvent(args: {
  businessId: string;
  actorEmployeeId: string | null;
  inReplyToEventId: string;
  intent: string;
  safeIntent: string;
  answer: string;
  confidence: number | null;
  requiresClarification: boolean;
  actionsEmitted: string[];
}): CompanionResponseEvent {
  return {
    protocol: EMPLOYEE_EVENT_PROTOCOL.name,
    protocolVersion: EMPLOYEE_EVENT_PROTOCOL.version,
    eventId: randomUUID(),
    emittedAt: new Date().toISOString(),
    type: "COMPANION_RESPONSE",
    businessId: args.businessId,
    actorEmployeeId: args.actorEmployeeId,
    inReplyToEventId: args.inReplyToEventId,
    intent: args.intent,
    safeIntent: args.safeIntent,
    answer: args.answer.slice(0, 500),
    confidence: args.confidence,
    requiresClarification: args.requiresClarification,
    actionsEmitted: args.actionsEmitted,
  };
}

export function buildStockIngressRequestEvent(args: {
  businessId: string;
  actorEmployeeId: string | null;
  items: StockIngressRequestEvent["items"];
  supplierName: string | null;
  maxIngressTicket: number;
}): StockIngressRequestEvent {
  const totalEstimatedValue = args.items.reduce((sum, i) => sum + i.quantity * i.unitCostPrice, 0);
  return {
    protocol: EMPLOYEE_EVENT_PROTOCOL.name,
    protocolVersion: EMPLOYEE_EVENT_PROTOCOL.version,
    eventId: randomUUID(),
    emittedAt: new Date().toISOString(),
    type: "STOCK_INGRESS_REQUEST",
    businessId: args.businessId,
    actorEmployeeId: args.actorEmployeeId,
    items: args.items,
    supplierName: args.supplierName,
    totalEstimatedValue,
    maxIngressTicket: args.maxIngressTicket,
  };
}

export function buildSupervisorQueryEvent(args: {
  businessId: string;
  actorEmployeeId: string | null;
  inReplyToEventId: string;
  escalationKind: "B1_clarification_loop" | "B2_long_input" | "owner_direct" | "companion_answer_escalation";
  supervisorAnswer: string;
}): SupervisorQueryEvent {
  return {
    protocol: EMPLOYEE_EVENT_PROTOCOL.name,
    protocolVersion: EMPLOYEE_EVENT_PROTOCOL.version,
    eventId: randomUUID(),
    emittedAt: new Date().toISOString(),
    type: "SUPERVISOR_QUERY",
    businessId: args.businessId,
    actorEmployeeId: args.actorEmployeeId,
    inReplyToEventId: args.inReplyToEventId,
    escalationKind: args.escalationKind,
    supervisorAnswer: args.supervisorAnswer.slice(0, 500),
  };
}
