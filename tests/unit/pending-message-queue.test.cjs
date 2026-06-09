const assert = require("node:assert/strict");
const test = require("node:test");

const {
  enqueuePendingMessage,
  dequeuePendingMessage,
  clearPendingMessages,
  pendingMessageCount,
  registerPendingMessageDrainer,
  drainNextPendingMessage,
} = require("../../src/app/dashboard/lib/pending-message-queue.ts");

// Module is singleton — clear between tests so they don't leak state.
function reset() {
  clearPendingMessages();
}

test("enqueue + dequeue: FIFO order", () => {
  reset();
  enqueuePendingMessage("a");
  enqueuePendingMessage("b");
  enqueuePendingMessage("c");
  assert.equal(pendingMessageCount(), 3);
  assert.equal(dequeuePendingMessage(), "a");
  assert.equal(dequeuePendingMessage(), "b");
  assert.equal(dequeuePendingMessage(), "c");
  assert.equal(dequeuePendingMessage(), null);
});

test("enqueue ignores empty/whitespace-only strings", () => {
  reset();
  enqueuePendingMessage("");
  enqueuePendingMessage("   ");
  enqueuePendingMessage("\t\n");
  assert.equal(pendingMessageCount(), 0);
});

test("clearPendingMessages drops everything", () => {
  reset();
  enqueuePendingMessage("a");
  enqueuePendingMessage("b");
  clearPendingMessages();
  assert.equal(pendingMessageCount(), 0);
  assert.equal(dequeuePendingMessage(), null);
});

test("drainNextPendingMessage calls registered handler with FIFO head", (t, done) => {
  reset();
  enqueuePendingMessage("first");
  enqueuePendingMessage("second");
  let received = "";
  const unregister = registerPendingMessageDrainer((text) => {
    received = text;
  });
  drainNextPendingMessage();
  // Handler runs on next tick (setTimeout 0)
  setTimeout(() => {
    assert.equal(received, "first");
    assert.equal(pendingMessageCount(), 1, "second should still be queued");
    unregister();
    done();
  }, 10);
});

test("drainNextPendingMessage with no handler is a no-op", () => {
  reset();
  enqueuePendingMessage("orphaned");
  // No drainer registered. The message should still be dequeued (popped)
  // but no handler runs. Note: current impl pops then bails — verify.
  // Actually re-reading: dequeues only if handler exists. Let's confirm
  // by checking count stays at 1.
  drainNextPendingMessage();
  assert.equal(pendingMessageCount(), 1, "no handler → message stays queued");
});

test("drain on empty queue is a no-op (no throw)", () => {
  reset();
  let called = false;
  const unregister = registerPendingMessageDrainer(() => { called = true; });
  drainNextPendingMessage();
  assert.equal(called, false);
  unregister();
});

test("registerPendingMessageDrainer cleanup function unregisters handler", (t, done) => {
  reset();
  let called = false;
  const unregister = registerPendingMessageDrainer(() => { called = true; });
  unregister();
  enqueuePendingMessage("orphan");
  drainNextPendingMessage();
  setTimeout(() => {
    assert.equal(called, false, "handler should not fire after unregister");
    done();
  }, 10);
});
