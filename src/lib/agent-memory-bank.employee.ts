import "server-only";
// Employee-scoped Memory Bank operations.
// Extracted from agent-memory-bank.ts to keep each file under the 300-line limit.
//
// All infrastructure (auth, memoriesRequest, timeout) lives in agent-memory-bank.ts
// and is re-exported / imported from there.
//
// Scope format: `employee:{businessId}:{employeeId}`
// Fail-soft: every public function catches all errors and returns [] / void.

import { memoriesRequest, isMemoryBankEnabled } from "@/lib/agent-memory-bank";
import { cloudLog } from "@/lib/cloud-logger";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface EmployeeMemory {
  /** Full resource name, e.g. ".../memories/123456789" */
  name: string;
  /** Raw text of the observation, e.g. "Employee prefers concise answers" */
  content: string;
  /** ISO-8601 timestamp from the API */
  createTime: string;
  /** Canonical scope key — always `employee_id:{businessId}:{employeeId}` */
  scope: string;
}

// ─── Scope helpers ────────────────────────────────────────────────────────────

/**
 * Canonical scope key string — used for post-fetch comparison and display.
 */
function employeeScopeKey(businessId: string, employeeId: string): string {
  return `employee_id:${businessId}:${employeeId}`;
}

/**
 * Scope object for Vertex AI Memory Bank API calls.
 * Vertex AI Agent Engine expects scope as a map<string, string>, NOT a flat
 * colon-delimited string. Sending "employee:x:y" causes a 400:
 * "Invalid value at 'scope'". Fix: BUG #41.
 */
function employeeScopeObj(businessId: string, employeeId: string): Record<string, string> {
  return { business_id: businessId, employee_id: employeeId };
}

/** @deprecated Use employeeScopeKey or employeeScopeObj internally. */
export function employeeScope(businessId: string, employeeId: string): string {
  return employeeScopeKey(businessId, employeeId);
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Persist a learned preference for a specific employee.
 * Scoped to `employee:{businessId}:{employeeId}` — never crosses businesses or employees.
 * Fire-and-forget safe — callers may void this.
 *
 * Defense in depth: rejects empty/whitespace businessId or employeeId before
 * reaching the API so an accidental empty string never taints the scope key.
 */
export async function saveEmployeeMemory(
  businessId: string,
  employeeId: string,
  content: string,
): Promise<void> {
  if (!isMemoryBankEnabled()) return;
  if (!businessId.trim() || !employeeId.trim()) return;
  if (!content.trim()) return;

  try {
    await memoriesRequest("POST", "memories", {
      scope: employeeScopeObj(businessId, employeeId),
      content,
    });
  } catch (err) {
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "MEMORY_BANK_SAVE_FAILED",
      a2a_transfer: false,
      message: "Memory Bank employee save failed — skipping",
      businessId,
      data: { employeeId, error: err instanceof Error ? err.message : String(err) },
    });
  }
}

/**
 * Retrieve memories for a specific employee.
 * Scoped strictly to `employee:{businessId}:{employeeId}`.
 * Returns [] on error so the caller can proceed without memories.
 *
 * Defense in depth: rejects empty/whitespace businessId or employeeId before
 * reaching the API.
 *
 * NOTE: memories:retrieve no longer accepts `query` or `top_k` (API change).
 * Only `scope` is accepted; all scoped memories are returned.
 */
export async function retrieveEmployeeMemories(
  businessId: string,
  employeeId: string,
  _query: string,
): Promise<EmployeeMemory[]> {
  if (!isMemoryBankEnabled()) return [];
  if (!businessId.trim() || !employeeId.trim()) return [];

  // PL-2: declare expected scope key before fetch for post-fetch validation.
  const expectedScopeKey = employeeScopeKey(businessId, employeeId);

  try {
    // NOTE: memories:retrieve no longer accepts `query` or `top_k` (API change —
    // both fields return 400 "Unknown name"). Only `scope` is accepted now.
    const data = await memoriesRequest("POST", "memories:retrieve", {
      scope: employeeScopeObj(businessId, employeeId),
    }) as { memories?: Array<{ name?: string; content?: string; createTime?: string; scope?: string }> } | null;

    if (!data?.memories) return [];

    const mapped = data.memories
      .filter((m) => typeof m.content === "string" && m.content.length > 0)
      .map((m) => ({
        name: m.name ?? "",
        content: m.content ?? "",
        createTime: m.createTime ?? new Date().toISOString(),
        scope: m.scope ?? expectedScopeKey,
      }));

    // PL-2: defense in depth — drop any memory whose scope doesn't exactly
    // match what we requested (guards against API prefix-match bugs).
    const safe = mapped.filter((m) => m.scope === expectedScopeKey);
    const droppedCount = mapped.length - safe.length;
    if (droppedCount > 0) {
      cloudLog({
        severity: "WARNING",
        component: "System",
        action: "MEMORY_BANK_SCOPE_LEAK_FILTERED",
        a2a_transfer: false,
        message: "Vertex returned memories with unexpected scope — dropped before prompt injection",
        businessId,
        data: { employeeId, expectedScopeKey, droppedCount },
      });
    }

    return safe;
  } catch (err) {
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "MEMORY_BANK_RETRIEVE_FAILED",
      a2a_transfer: false,
      message: "Memory Bank employee retrieve failed — returning empty",
      businessId,
      data: { employeeId, error: err instanceof Error ? err.message : String(err) },
    });
    return [];
  }
}
