// Unit tests for the assistant chat latency tracker.
// G3-2 — Phase 2-7 audit: el módulo emitía Cloud Logging sin coverage.

const assert = require("node:assert/strict");
const test = require("node:test");

const { createLatencyTracker } = require("../../src/app/api/business-assistant/_lib/latency-tracker.ts");

// Capture cloud-logger output via console intercept.
function captureConsole(fn) {
  const captured = [];
  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;
  console.log = (s) => captured.push({ stream: "log", line: s });
  console.warn = (s) => captured.push({ stream: "warn", line: s });
  console.error = (s) => captured.push({ stream: "error", line: s });
  try { fn(); } finally {
    console.log = origLog;
    console.warn = origWarn;
    console.error = origError;
  }
  return captured;
}

function parseLast(captured) {
  return JSON.parse(captured[captured.length - 1].line);
}

test("createLatencyTracker: emits structured log with totalMs + phaseMs", () => {
  const t = createLatencyTracker();
  t.start("preModel");
  // simulate work
  const end = Date.now() + 5;
  while (Date.now() < end) { /* spin */ }
  t.end("preModel");
  t.setMeta("path", "pre-model");
  const caps = captureConsole(() => t.emit({ businessId: "biz-1" }));
  const entry = parseLast(caps);
  assert.equal(entry.severity, "INFO");
  assert.equal(entry.action, "ASSISTANT_CHAT_LATENCY");
  assert.equal(entry.a2a_transfer, false);
  assert.equal(entry.businessId, "biz-1");
  assert.equal(entry.data.path, "pre-model");
  assert.ok(typeof entry.data.totalMs === "number" && entry.data.totalMs >= 0);
  assert.ok(typeof entry.data.phaseMs.preModel === "number" && entry.data.phaseMs.preModel >= 0);
});

test("createLatencyTracker: multiple phases recorded", () => {
  const t = createLatencyTracker();
  t.start("a"); t.end("a");
  t.start("b"); t.end("b");
  t.setMeta("path", "model");
  const caps = captureConsole(() => t.emit({ businessId: "biz-1" }));
  const entry = parseLast(caps);
  assert.ok("a" in entry.data.phaseMs);
  assert.ok("b" in entry.data.phaseMs);
});

test("createLatencyTracker: end without start is no-op", () => {
  const t = createLatencyTracker();
  t.end("never-started"); // should not throw
  const caps = captureConsole(() => t.emit({ businessId: "biz-1" }));
  const entry = parseLast(caps);
  assert.deepEqual(entry.data.phaseMs, {});
});

test("createLatencyTracker: setMeta merges values into data", () => {
  const t = createLatencyTracker();
  t.setMeta("intent", "register_sale");
  t.setMeta("path", "model");
  t.setMeta("inputSample", "vendi 2 X");
  const caps = captureConsole(() => t.emit({ businessId: "biz-1" }));
  const entry = parseLast(caps);
  assert.equal(entry.data.intent, "register_sale");
  assert.equal(entry.data.path, "model");
  assert.equal(entry.data.inputSample, "vendi 2 X");
});

test("createLatencyTracker: emit called twice is idempotent", () => {
  const t = createLatencyTracker();
  t.setMeta("path", "pre-model");
  const caps = captureConsole(() => {
    t.emit({ businessId: "biz-1" });
    t.emit({ businessId: "biz-1" });
  });
  // Should only emit once.
  assert.equal(caps.length, 1);
});

test("createLatencyTracker: includes actorUserId + actorEmployeeId when provided", () => {
  const t = createLatencyTracker();
  t.setMeta("path", "model");
  const caps = captureConsole(() => t.emit({
    businessId: "biz-1",
    actorUserId: "user-1",
    actorEmployeeId: "emp-1",
  }));
  const entry = parseLast(caps);
  assert.equal(entry.actorUserId, "user-1");
  assert.equal(entry.actorEmployeeId, "emp-1");
});

test("createLatencyTracker: actorEmployeeId null becomes undefined", () => {
  const t = createLatencyTracker();
  t.setMeta("path", "model");
  const caps = captureConsole(() => t.emit({
    businessId: "biz-1",
    actorEmployeeId: null,
  }));
  const entry = parseLast(caps);
  assert.equal(entry.actorEmployeeId, undefined);
});
