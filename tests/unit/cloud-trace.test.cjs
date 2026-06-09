// Tests for the Cloud Trace integration in cloud-logger.ts.
// Closes the distributed tracing gap (Phase 5+7 → 10) without pulling in
// @opentelemetry/sdk-node — Cloud Run already injects the trace header,
// we just have to surface it in our structured logs.

process.env.AUTH_SECRET = process.env.AUTH_SECRET || "test-cloud-trace-secret-32-bytes-long";
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://test:test@localhost:5432/test";
process.env.GCP_PROJECT_ID = "my-gcp-project";

const assert = require("node:assert/strict");
const test = require("node:test");

const { traceFieldsFromHeaders, runWithTraceContext, cloudLog } = require("../../src/lib/cloud-logger.ts");

function mkHeaders(values) {
  return { get: (name) => values[name.toLowerCase()] ?? null };
}

// ── traceFieldsFromHeaders ─────────────────────────────────────────────

test("traceFieldsFromHeaders: sin header → empty object", () => {
  const f = traceFieldsFromHeaders(mkHeaders({}));
  assert.deepEqual(f, {});
});

test("traceFieldsFromHeaders: header completo TRACE/SPAN;o=1 → all 3 fields", () => {
  const f = traceFieldsFromHeaders(
    mkHeaders({ "x-cloud-trace-context": "abc123def456abc123def456abc123de/12345;o=1" }),
  );
  assert.equal(f["logging.googleapis.com/trace"], "projects/my-gcp-project/traces/abc123def456abc123def456abc123de");
  assert.equal(f["logging.googleapis.com/spanId"], "12345");
  assert.equal(f["logging.googleapis.com/trace_sampled"], true);
});

test("traceFieldsFromHeaders: o=0 → trace_sampled false", () => {
  const f = traceFieldsFromHeaders(
    mkHeaders({ "x-cloud-trace-context": "abc/123;o=0" }),
  );
  assert.equal(f["logging.googleapis.com/trace_sampled"], false);
});

test("traceFieldsFromHeaders: header sin spanId acepta el formato sólo trace", () => {
  const f = traceFieldsFromHeaders(
    mkHeaders({ "x-cloud-trace-context": "abc123" }),
  );
  assert.equal(f["logging.googleapis.com/trace"], "projects/my-gcp-project/traces/abc123");
  assert.equal(f["logging.googleapis.com/spanId"], undefined);
});

test("traceFieldsFromHeaders: usa GCP_PROJECT_ID para la URL canónica", () => {
  const original = process.env.GCP_PROJECT_ID;
  // The PROJECT_ID is captured at module load; this verifies the
  // resolution path uses the env var that was set above.
  const f = traceFieldsFromHeaders(
    mkHeaders({ "x-cloud-trace-context": "tid/sid;o=1" }),
  );
  assert.match(f["logging.googleapis.com/trace"], new RegExp(`projects/${original}/traces/`));
});

// ── runWithTraceContext + cloudLog ─────────────────────────────────────

test("runWithTraceContext: cloudLog inside the callback emits trace fields", (t) => {
  const captured = [];
  const origLog = console.log;
  console.log = (line) => captured.push(JSON.parse(line));
  t.after(() => { console.log = origLog; });

  runWithTraceContext(
    mkHeaders({ "x-cloud-trace-context": "trace777/span999;o=1" }),
    () => {
      cloudLog({
        severity: "INFO",
        component: "System",
        action: "TEST",
        a2a_transfer: false,
        message: "hi",
      });
    },
  );

  assert.equal(captured.length, 1);
  assert.equal(
    captured[0]["logging.googleapis.com/trace"],
    "projects/my-gcp-project/traces/trace777",
  );
  assert.equal(captured[0]["logging.googleapis.com/spanId"], "span999");
  assert.equal(captured[0]["logging.googleapis.com/trace_sampled"], true);
});

test("cloudLog outside runWithTraceContext: no trace fields", (t) => {
  const captured = [];
  const origLog = console.log;
  console.log = (line) => captured.push(JSON.parse(line));
  t.after(() => { console.log = origLog; });

  cloudLog({
    severity: "INFO",
    component: "System",
    action: "OUTSIDE",
    a2a_transfer: false,
    message: "no trace ctx",
  });

  assert.equal(captured.length, 1);
  assert.equal(captured[0]["logging.googleapis.com/trace"], undefined);
});

test("runWithTraceContext: null headers passes through", () => {
  let ran = false;
  const result = runWithTraceContext(null, () => {
    ran = true;
    return 42;
  });
  assert.equal(ran, true);
  assert.equal(result, 42);
});

test("runWithTraceContext: header without x-cloud-trace-context still runs the fn", () => {
  let ran = false;
  runWithTraceContext(mkHeaders({}), () => { ran = true; });
  assert.equal(ran, true);
});
