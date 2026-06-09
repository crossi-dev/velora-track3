"use client";

import type {
  AssistantConfirmationRequest,
  AssistantStockDraft,
  PurchaseRequestRecord,
} from "./types";

export const DASHBOARD_DRAFT_VERSION = "2.5-phase4";

export interface DashboardDraftSnapshot {
  version: string;
  latestPurchaseRequest: PurchaseRequestRecord | null;
  assistantStockDraft: AssistantStockDraft | null;
  assistantConfirmationRequest: AssistantConfirmationRequest | null;
  assistantQuestionContext: string | null;
  assistantInputHint: string | null;
}

interface BuildDashboardDraftSnapshotParams {
  latestPurchaseRequest: PurchaseRequestRecord | null;
  assistantStockDraft: AssistantStockDraft | null;
  assistantConfirmationRequest: AssistantConfirmationRequest | null;
  assistantQuestionContext: string | null;
  assistantInputHint: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isPurchaseRequestRecord(value: unknown): value is PurchaseRequestRecord {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.requestNumber !== "string" ||
    typeof value.issuedAt !== "string" ||
    typeof value.currency !== "string" ||
    typeof value.totalAmount !== "number"
  ) {
    return false;
  }

  // payload is `PurchaseRequestPayload | null`; accept null, undefined, or an object.
  // Deep payload validation is deferred — we only guard the top-level record shape here.
  return value.payload === null || value.payload === undefined || isRecord(value.payload);
}

function isAssistantStockDraft(value: unknown): value is AssistantStockDraft {
  if (!isRecord(value) || typeof value.supplierName !== "string" || !Array.isArray(value.items)) {
    return false;
  }

  return value.items.every((item) => {
    if (
      !isRecord(item) ||
      typeof item.itemName !== "string" ||
      !item.itemName.trim() ||
      typeof item.quantity !== "string" ||
      typeof item.unitPrice !== "string"
    ) {
      return false;
    }
    const qty = parseInt(item.quantity as string, 10);
    const price = parseFloat(item.unitPrice as string);
    if (!Number.isFinite(qty) || qty <= 0) {
      console.warn("[draft-persistence] invalid quantity", item.quantity);
      return false;
    }
    if (!Number.isFinite(price) || price <= 0) {
      console.warn("[draft-persistence] invalid unitPrice", item.unitPrice);
      return false;
    }
    return true;
  });
}

function isAssistantConfirmationRequest(value: unknown): value is AssistantConfirmationRequest {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.title !== "string" ||
    typeof value.message !== "string" ||
    typeof value.confirmLabel !== "string" ||
    typeof value.cancelLabel !== "string" ||
    (value.severity !== "warning" && value.severity !== "critical")
  ) {
    return false;
  }

  return isRecord(value.action) && typeof value.action.type === "string";
}

export function buildDashboardDraftSnapshot({
  latestPurchaseRequest,
  assistantStockDraft,
  assistantConfirmationRequest,
  assistantQuestionContext,
  assistantInputHint,
}: BuildDashboardDraftSnapshotParams): DashboardDraftSnapshot {
  return {
    version: DASHBOARD_DRAFT_VERSION,
    latestPurchaseRequest,
    assistantStockDraft,
    assistantConfirmationRequest,
    assistantQuestionContext,
    assistantInputHint,
  };
}

export function hasDashboardDraftContent(snapshot: DashboardDraftSnapshot): boolean {
  return Boolean(
    snapshot.latestPurchaseRequest ||
    snapshot.assistantStockDraft ||
    snapshot.assistantConfirmationRequest ||
    snapshot.assistantQuestionContext ||
    snapshot.assistantInputHint
  );
}

export function parseDashboardDraftSnapshot(raw: string | null): DashboardDraftSnapshot | null {
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return null;

    const latestPurchaseRequest = isPurchaseRequestRecord(parsed.latestPurchaseRequest)
      ? parsed.latestPurchaseRequest
      : null;
    const assistantStockDraft = isAssistantStockDraft(parsed.assistantStockDraft)
      ? parsed.assistantStockDraft
      : null;
    const assistantConfirmationRequest = isAssistantConfirmationRequest(parsed.assistantConfirmationRequest)
      ? parsed.assistantConfirmationRequest
      : null;
    const assistantQuestionContext = isNullableString(parsed.assistantQuestionContext)
      ? parsed.assistantQuestionContext
      : null;
    const assistantInputHint = isNullableString(parsed.assistantInputHint)
      ? parsed.assistantInputHint
      : null;

    const snapshotVersion = typeof parsed.version === "string" ? parsed.version : null;
    if (snapshotVersion !== DASHBOARD_DRAFT_VERSION) return null;

    return {
      version: snapshotVersion,
      latestPurchaseRequest,
      assistantStockDraft,
      assistantConfirmationRequest,
      assistantQuestionContext,
      assistantInputHint,
    };
  } catch (err) {
    console.warn("[dashboard-draft] parse error:", err);
    return null;
  }
}
