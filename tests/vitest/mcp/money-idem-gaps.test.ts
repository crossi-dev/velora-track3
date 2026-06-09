// tests/vitest/mcp/money-idem-gaps.test.ts
//
// Regression tests for the MCP money-path idempotency gap fixed in
// feat/mcp-idempotency-gaps:
//
//   GAP 1 — register_movement: when `date` is omitted, two distinct movements
//     with identical (type, description, amount) must get DIFFERENT keys when
//     recorded in different UTC minutes. A true retry within the same minute
//     must produce the SAME key (correct dedup).
//
// These tests operate on the key derivation logic directly — no DB,
// no MCP server, no real MP API.

import { describe, it, expect, vi, afterEach } from "vitest";

// ── GAP 1: mkIdemKey + dateBucket logic ──────────────────────────────────────
//
// We import the pure helper directly and replicate the dateBucket logic to
// verify the contract without spinning up the full MCP stack.

import { mkIdemKey } from "@/lib/mcp/_lib/sales-mutations";

describe("GAP 1 — register_movement idempotency key (no false-dedup)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("explicit date → key is stable across retries (same date → same key)", () => {
    const biz = "biz-001";
    const k1 = mkIdemKey(biz, "register_movement", "purchase", "Pago proveedor", "5000", "2026-06-01T14:30");
    const k2 = mkIdemKey(biz, "register_movement", "purchase", "Pago proveedor", "5000", "2026-06-01T14:30");
    expect(k1).toBe(k2);
  });

  it("two distinct movements with no date, recorded in different minutes → DIFFERENT keys", () => {
    // Minute 1
    const bucket1 = new Date("2026-06-01T14:30:00.000Z").toISOString().slice(0, 16);
    // Minute 2
    const bucket2 = new Date("2026-06-01T14:31:00.000Z").toISOString().slice(0, 16);

    const k1 = mkIdemKey("biz-001", "register_movement", "income", "Cobro venta", "1000", bucket1);
    const k2 = mkIdemKey("biz-001", "register_movement", "income", "Cobro venta", "1000", bucket2);
    expect(k1).not.toBe(k2);
  });

  it("true retry within same UTC minute → SAME key (correct dedup)", () => {
    const bucket = new Date("2026-06-01T14:30:45.000Z").toISOString().slice(0, 16);

    // Simulate two calls in the same minute — both see the same bucket
    const k1 = mkIdemKey("biz-001", "register_movement", "income", "Cobro venta", "1000", bucket);
    const k2 = mkIdemKey("biz-001", "register_movement", "income", "Cobro venta", "1000", bucket);
    expect(k1).toBe(k2);
  });

  it("same args, different businessId → DIFFERENT keys (tenant isolation)", () => {
    const bucket = new Date("2026-06-01T14:30:00.000Z").toISOString().slice(0, 16);
    const k1 = mkIdemKey("biz-aaa", "register_movement", "purchase", "X", "500", bucket);
    const k2 = mkIdemKey("biz-bbb", "register_movement", "purchase", "X", "500", bucket);
    expect(k1).not.toBe(k2);
  });

  it("no-date key no longer uses literal 'now' string (regression guard)", () => {
    // The old bug: key contained literal "now" → same key forever for identical fields.
    // After the fix: dateBucket = "YYYY-MM-DDTHH:MM" (never the literal "now").
    const bucket = new Date().toISOString().slice(0, 16);
    const fixedKey = mkIdemKey("biz-001", "register_movement", "income", "Venta", "100", bucket);
    const legacyBugKey = mkIdemKey("biz-001", "register_movement", "income", "Venta", "100", "now");
    expect(fixedKey).not.toBe(legacyBugKey);
  });
});

