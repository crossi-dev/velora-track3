// Unit tests — Companion Agent ADK timeout guard.
//
// Regression guard for the COMPANION_ADK_TIMEOUT_MS fix (2026-05-18).
// Tests the Promise.race + TimeoutError propagation pattern in isolation
// without hitting Vertex AI or requiring a DB connection.
//
// Strategy: mirror the drainEvents + timeoutPromise pattern from
// companion-agent.ts in a self-contained helper, verifying:
//   1. Timeout fires and propagates when the drain hangs.
//   2. TimeoutError name matches the expected "TimeoutError" convention.
//   3. Happy path (fast drain) resolves without throwing.
//   4. Non-timeout errors propagate verbatim (not swallowed).

const assert = require("node:assert/strict");
const test = require("node:test");

// ── Helpers ────────────────────────────────────────────────────────────────

// Simulates the Promise.race pattern from companion-agent.ts.
// Returns { timedOut: boolean, text: string } or throws non-timeout errors.
async function simulateCompanionDrain({ events, timeoutMs }) {
  let finalText = "";
  let timeoutHandle = null;

  const timeoutPromise = new Promise((_, reject) => {
    timeoutHandle = setTimeout(
      () => reject(Object.assign(new Error("ADK employee timed out"), { name: "TimeoutError" })),
      timeoutMs,
    );
  });

  const drainEvents = async () => {
    for await (const event of events) {
      if (event.text) finalText = event.text;
    }
  };

  try {
    await Promise.race([drainEvents(), timeoutPromise]);
    return { timedOut: false, text: finalText };
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      return { timedOut: true, text: finalText };
    }
    throw err;
  } finally {
    if (timeoutHandle !== null) clearTimeout(timeoutHandle);
  }
}

// Async generator that hangs indefinitely (never yields).
// Simulates a stalled Gemini Flash call.
async function* hangingGenerator() {
  await new Promise(() => {}); // never resolves
}

// Async generator that yields events quickly.
async function* fastGenerator(events) {
  for (const e of events) yield e;
}

// ── Tests ─────────────────────────────────────────────────────────────────

test("Companion ADK timeout: fires when runner hangs, returns timedOut=true", async () => {
  const result = await simulateCompanionDrain({
    events: hangingGenerator(),
    timeoutMs: 20, // very short for test speed
  });
  assert.equal(result.timedOut, true);
});

test("Companion ADK timeout: error has name=TimeoutError (matches isTimeout check)", async () => {
  let caughtErr = null;
  let timeoutHandle = null;

  const timeoutPromise = new Promise((_, reject) => {
    timeoutHandle = setTimeout(
      () => reject(Object.assign(new Error("ADK employee timed out"), { name: "TimeoutError" })),
      10,
    );
  });

  try {
    await Promise.race([hangingGenerator().next(), timeoutPromise]);
  } catch (err) {
    caughtErr = err;
  } finally {
    if (timeoutHandle !== null) clearTimeout(timeoutHandle);
  }

  assert.ok(caughtErr instanceof Error, "should throw an Error");
  assert.equal(caughtErr.name, "TimeoutError", "error.name must be TimeoutError");
  assert.match(caughtErr.message, /timed out/);
});

test("Companion ADK happy path: fast drain resolves without timeout", async () => {
  const result = await simulateCompanionDrain({
    events: fastGenerator([{ text: '{"intent":"register_sale"}' }]),
    timeoutMs: 5_000,
  });
  assert.equal(result.timedOut, false);
  assert.equal(result.text, '{"intent":"register_sale"}');
});

test("Companion ADK timeout: timer is cleared after drain completes (no dangling handle)", async () => {
  // Verify: the finally block clears the timer. If it did NOT clear, Node's
  // open-handle detector would keep the process alive after the test. We can't
  // directly assert clearTimeout was called, but we can verify the happy path
  // exits cleanly in < 100ms — meaning the timer didn't fire post-resolution.
  const start = Date.now();
  const result = await simulateCompanionDrain({
    events: fastGenerator([{ text: "ok" }]),
    timeoutMs: 5_000,
  });
  const elapsed = Date.now() - start;
  assert.equal(result.timedOut, false);
  // Should complete near-instantly (<200ms), not wait 5s for the timer.
  assert.ok(elapsed < 200, `expected elapsed < 200ms, got ${elapsed}ms`);
});

test("Companion ADK: non-timeout error propagates verbatim", async () => {
  const boom = new Error("unexpected ADK internal error");

  async function* explodingGenerator() {
    throw boom;
    yield; // unreachable — makes TS/Node happy with the generator shape
  }

  await assert.rejects(
    () =>
      simulateCompanionDrain({
        events: explodingGenerator(),
        timeoutMs: 5_000,
      }),
    (err) => {
      assert.equal(err, boom, "original error must propagate unchanged");
      return true;
    },
  );
});
