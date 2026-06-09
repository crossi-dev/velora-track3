/**
 * Shared confirmation fast-path logic used by both the owner and employee
 * pipelines. Extracted to avoid byte-for-byte duplication between
 * ownerConfirmationFastPathStage and employeeConfirmationFastPathStage.
 *
 * The only call-site differences are logging labels (component, path, trace
 * string) and the actorEmployeeId value (null for owner, real id for employee).
 */
import type { NextResponse } from "next/server";
import { cloudLog } from "@/lib/cloud-logger";
import { detectConfirmationAnswer } from "./nlu/confirmation-response";
import { getPendingConfirmation } from "./nlu/pending-confirmation";
import type { PendingConfirmationCarrier } from "./nlu/pending-confirmation";
import type { LatencyTracker } from "./latency-tracker";

/** Minimal trace interface — structurally compatible with both owner and employee pipeline traces. */
interface TraceMin {
  add: (step: string, detail: string) => void;
}

export interface ConfirmationFastPathParams {
  text: string;
  recentHistory: PendingConfirmationCarrier[];
  businessId: string;
  actorUserId: string;
  actorEmployeeId: string | null;
  trace: TraceMin;
  latency: LatencyTracker;
  respond: (body: Record<string, unknown>, status?: number) => Promise<NextResponse>;
  /** "owner" | "employee" — drives logging labels only. */
  role: "owner" | "employee";
}

/**
 * Returns a response when the last assistant turn left a pending
 * confirmationRequest AND the user's text resolves to yes/no deterministically.
 * Returns null otherwise (fall through to the next pipeline stage).
 */
export async function runConfirmationFastPath(
  p: ConfirmationFastPathParams,
): Promise<NextResponse | null> {
  const pending = getPendingConfirmation(p.recentHistory);
  if (!pending) return null;
  const answer = detectConfirmationAnswer(p.text);
  if (answer === null) return null;

  const pathLabel = `${p.role}-confirmation-fast-path`;
  const component = p.role === "owner" ? "System" : "Employee";

  p.latency.setMeta("path", pathLabel);
  p.latency.emit({ businessId: p.businessId, actorUserId: p.actorUserId, actorEmployeeId: p.actorEmployeeId });
  p.trace.add("routing", `${p.role} → confirmation fast path (${answer})`);

  cloudLog({
    severity: "INFO",
    component,
    action: "CONFIRMATION_FAST_PATH_HIT",
    a2a_transfer: false,
    message: `confirmation ${answer} resolved deterministically (${p.role})`,
    businessId: p.businessId,
    ...(p.actorEmployeeId !== null ? { actorEmployeeId: p.actorEmployeeId } : {}),
    data: { answer, actionType: pending.action.type, source: "deterministic" },
  });

  if (answer === "yes") {
    return p.respond({
      answer: "Confirmado.",
      clientAction: "execute_pending_confirmation",
      pendingConfirmation: { action: pending.action },
    });
  }
  return p.respond({
    answer: "Cancelado.",
    clientAction: "cancel_pending_confirmation",
  });
}
