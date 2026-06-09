// Contract for the chat state machine — replaces the implicit coordination
// between inFlightRef, pendingConfirmation, queue refs, and offline state.
// Tests run against the pure reducer; React-side wiring is integration-tested
// separately later.
//
// All tests are .skip during commit 1 because chatStateReducer is a stub.
// Each test moves to active as commits 7-10 land the real transitions.

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  chatStateReducer,
  INITIAL_CHAT_STATE,
  isBusy,
  shouldEnqueue,
} = require("../../src/app/dashboard/lib/chat-state-machine.ts");

// ─── isBusy / shouldEnqueue helpers (testable now since they're pure) ─

test("isBusy: idle → false; everything else → true except offline", () => {
  assert.equal(isBusy({ kind: "idle" }), false);
  assert.equal(isBusy({ kind: "offline" }), false);
  assert.equal(isBusy({ kind: "processing", reason: "ai-call", startedAt: 0 }), true);
  assert.equal(isBusy({ kind: "draining-offline" }), true);
});

test("shouldEnqueue: only states that hold work in flight enqueue new submits", () => {
  assert.equal(shouldEnqueue({ kind: "idle" }), false);
  assert.equal(shouldEnqueue({ kind: "offline" }), false);
  assert.equal(shouldEnqueue({ kind: "processing", reason: "ai-call", startedAt: 0 }), true);
  assert.equal(shouldEnqueue({ kind: "pending-confirmation", request: {} }), true);
  assert.equal(shouldEnqueue({ kind: "executing-confirmation", request: {} }), true);
  assert.equal(shouldEnqueue({ kind: "draining-offline" }), true);
});

// ─── Fixture S1: happy path AI ──────────────────────────────────────

test("S1: idle → submit → processing → ai-resolved → idle", () => {
  let state = INITIAL_CHAT_STATE;
  state = chatStateReducer(state, { type: "submit", text: "vendí algo" });
  assert.equal(state.kind, "processing");
  state = chatStateReducer(state, { type: "ai-resolved" });
  assert.equal(state.kind, "idle");
});

// ─── Fixture S2: submit while processing → enqueue (state unchanged) ─

test("S2: submit while processing keeps state, signals enqueue intent", () => {
  let state = INITIAL_CHAT_STATE;
  state = chatStateReducer(state, { type: "submit", text: "first" });
  assert.equal(state.kind, "processing");
  // shouldEnqueue should be true; the reducer itself doesn't mutate
  // the queue (that lives in pending-message-queue.ts) but the wrapper
  // hook reads shouldEnqueue and enqueues.
  assert.ok(shouldEnqueue(state));
  // Submitting again should NOT take us out of processing.
  const next = chatStateReducer(state, { type: "submit", text: "second" });
  assert.equal(next.kind, "processing", "second submit must not transition out");
});

// ─── Fixture S3: pending-confirmation blocks non-affirmation ────────

test("S3: submit during pending-confirmation does not transition out", () => {
  const fakeRequest = { id: "req-1", title: "Confirm sale", action: { type: "register_sale" } };
  let state = chatStateReducer(INITIAL_CHAT_STATE, { type: "confirmation-requested", request: fakeRequest });
  assert.equal(state.kind, "pending-confirmation");
  // Random non-affirmation submit must not trip the state — the hook
  // layer detects non-affirmation and routes to "block + warn", never
  // emits user-confirmed.
  const next = chatStateReducer(state, { type: "submit", text: "hola" });
  assert.equal(next.kind, "pending-confirmation");
});

// ─── Fixture S4: pending-confirmation → user-confirmed → executing ──

test("S4: user-confirmed transitions pending-confirmation → executing-confirmation", () => {
  const fakeRequest = { id: "req-1", title: "Confirm sale", action: { type: "register_sale" } };
  let state = chatStateReducer(INITIAL_CHAT_STATE, { type: "confirmation-requested", request: fakeRequest });
  state = chatStateReducer(state, { type: "user-confirmed" });
  assert.equal(state.kind, "executing-confirmation");
});

// ─── Fixture S5: full confirm cycle drains queue ────────────────────

test("S5: executing-confirmation → execution-completed → idle", () => {
  const fakeRequest = { id: "req-1", title: "Confirm sale", action: { type: "register_sale" } };
  let state = chatStateReducer(INITIAL_CHAT_STATE, { type: "confirmation-requested", request: fakeRequest });
  state = chatStateReducer(state, { type: "user-confirmed" });
  state = chatStateReducer(state, { type: "execution-completed" });
  assert.equal(state.kind, "idle");
});

// ─── Fixture S6: submit during executing-confirmation enqueues ──────

test("S6: submit during executing-confirmation does not transition out", () => {
  const fakeRequest = { id: "req-1", title: "Confirm sale", action: { type: "register_sale" } };
  let state = chatStateReducer(INITIAL_CHAT_STATE, { type: "confirmation-requested", request: fakeRequest });
  state = chatStateReducer(state, { type: "user-confirmed" });
  assert.equal(state.kind, "executing-confirmation");
  const next = chatStateReducer(state, { type: "submit", text: "qué stock tengo" });
  assert.equal(next.kind, "executing-confirmation");
  assert.ok(shouldEnqueue(next));
});

// ─── Fixture S7: watchdog from processing → idle + error ────────────

test("S7: watchdog-tripped from processing returns to idle", () => {
  let state = chatStateReducer(INITIAL_CHAT_STATE, { type: "submit", text: "x" });
  assert.equal(state.kind, "processing");
  state = chatStateReducer(state, { type: "watchdog-tripped" });
  assert.equal(state.kind, "idle");
});

// ─── Fixture S8: online → drain → idle when queue empty ─────────────

test("S8: online from offline → draining-offline → idle on drain-completed", () => {
  let state = { kind: "offline" };
  state = chatStateReducer(state, { type: "online" });
  assert.equal(state.kind, "draining-offline");
  state = chatStateReducer(state, { type: "drain-completed" });
  assert.equal(state.kind, "idle");
});
