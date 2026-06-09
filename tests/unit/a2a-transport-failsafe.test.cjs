// Regression tests for the A2A transport fail-closed fix.
// getA2ATransport() must THROW (not warn) in production when A2A_TRANSPORT is not
// 'pubsub', so a misconfigured deploy fails loudly instead of running on the
// unreliable loopback (duplicate-event races on multi-instance Cloud Run).

"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  getActiveTransportKind,
  getA2ATransport,
  setTransportForTest,
} = require("../../src/lib/a2a-transport.ts");

function withEnv(node, transport, fn) {
  const prevNode = process.env.NODE_ENV;
  const prevT = process.env.A2A_TRANSPORT;
  if (node === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = node;
  if (transport === undefined) delete process.env.A2A_TRANSPORT; else process.env.A2A_TRANSPORT = transport;
  try { return fn(); }
  finally {
    if (prevNode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prevNode;
    if (prevT === undefined) delete process.env.A2A_TRANSPORT; else process.env.A2A_TRANSPORT = prevT;
    setTransportForTest(null); // clear the per-process cache
  }
}

test("getActiveTransportKind: unset → loopback", () => {
  withEnv("test", undefined, () => {
    assert.equal(getActiveTransportKind(), "loopback");
  });
});

test("getActiveTransportKind: 'pubsub' → pubsub", () => {
  withEnv("test", "pubsub", () => {
    assert.equal(getActiveTransportKind(), "pubsub");
  });
});

test("getA2ATransport: THROWS in production when transport is not pubsub", () => {
  withEnv("production", undefined, () => {
    setTransportForTest(null);
    assert.throws(() => getA2ATransport(), /pubsub/i);
  });
});

test("getA2ATransport: non-production loopback does NOT throw", () => {
  withEnv("test", undefined, () => {
    setTransportForTest(null);
    assert.doesNotThrow(() => getA2ATransport());
  });
});
