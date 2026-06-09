import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getActiveTransportKind,
  getA2ATransport,
  setTransportForTest,
  TestTransport,
} from "@/lib/a2a-transport";
import type { EmployeeEvent } from "@/lib/agent-contract";

// Minimal stub so tests don't need a real businessId/eventId structure
function stubEvent(overrides: Partial<EmployeeEvent> = {}): EmployeeEvent {
  return {
    protocol: "velora-a2a/1.0",
    protocolVersion: "1.0",
    eventId: "test-event-id",
    businessId: "test-biz",
    type: "SALE_REPORT",
    ...overrides,
  } as EmployeeEvent;
}

// ─── getActiveTransportKind ──────────────────────────────────────────────────

describe("getActiveTransportKind", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns "loopback" when A2A_TRANSPORT is not set', () => {
    vi.stubEnv("A2A_TRANSPORT", undefined);
    expect(getActiveTransportKind()).toBe("loopback");
  });

  it('returns "loopback" when A2A_TRANSPORT is "loopback"', () => {
    vi.stubEnv("A2A_TRANSPORT", "loopback");
    expect(getActiveTransportKind()).toBe("loopback");
  });

  it('returns "pubsub" when A2A_TRANSPORT is "pubsub"', () => {
    vi.stubEnv("A2A_TRANSPORT", "pubsub");
    expect(getActiveTransportKind()).toBe("pubsub");
  });

  it('returns "pubsub" for uppercase "PUBSUB" (case-insensitive)', () => {
    vi.stubEnv("A2A_TRANSPORT", "PUBSUB");
    expect(getActiveTransportKind()).toBe("pubsub");
  });

  it('returns "loopback" for unrecognized values', () => {
    vi.stubEnv("A2A_TRANSPORT", "redis");
    expect(getActiveTransportKind()).toBe("loopback");
  });
});

// ─── TestTransport ───────────────────────────────────────────────────────────

describe("TestTransport", () => {
  it("captures published events in published[]", async () => {
    const t = new TestTransport();
    const event = stubEvent();
    await t.publish(event);
    expect(t.published).toHaveLength(1);
    expect(t.published[0]).toBe(event);
  });

  it("returns a messageId derived from eventId by default", async () => {
    const t = new TestTransport();
    const result = await t.publish(stubEvent({ eventId: "ev-999" }));
    expect(result.messageId).toMatch(/^ev-999-/);
  });

  it("returns the configured reply when setReply is called", async () => {
    const t = new TestTransport();
    t.setReply({ messageId: "fixed-id", notification: null });
    const result = await t.publish(stubEvent());
    expect(result.messageId).toBe("fixed-id");
  });

  it("reset() clears published events and reverts to default reply", async () => {
    const t = new TestTransport();
    t.setReply({ messageId: "x", notification: null });
    await t.publish(stubEvent({ eventId: "ev-1" }));
    t.reset();
    expect(t.published).toHaveLength(0);
    const result = await t.publish(stubEvent({ eventId: "ev-2" }));
    expect(result.messageId).toMatch(/^ev-2-/);
  });
});

// ─── setTransportForTest / getA2ATransport ───────────────────────────────────

describe("setTransportForTest / getA2ATransport", () => {
  beforeEach(() => {
    setTransportForTest(null);
  });

  afterEach(() => {
    setTransportForTest(null);
  });

  it("returns the injected transport when override is set", () => {
    const t = new TestTransport();
    setTransportForTest(t);
    expect(getA2ATransport()).toBe(t);
  });

  it("multiple calls to getA2ATransport return the same override instance", () => {
    const t = new TestTransport();
    setTransportForTest(t);
    expect(getA2ATransport()).toBe(getA2ATransport());
  });
});
