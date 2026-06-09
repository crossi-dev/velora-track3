// Unit tests for the chat pipeline registry. Two small assertions:
//   1. buildPhasePipeline emits stages in the canonical phase order
//      regardless of the order the input record's keys appear in.
//   2. buildPhasePipeline throws if any phase is missing from the input
//      record (forces callers to acknowledge every phase explicitly).
//
// Background: 2026-05-09 production bug — preFilterStage at the front of
// a positional array short-circuited bare commands ("deshacer", "agua",
// "cambia el telefono de Juan") before NLU/LLM ran. The named-phase
// registry makes that class of bug structurally impossible.

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  Phase,
  buildPhasePipeline,
} = require("../../src/app/api/business-assistant/_lib/pipeline-registry.ts");

function namedStage(name) {
  return { name, run: async () => null };
}

test("buildPhasePipeline: flattens phases in canonical order regardless of input key order", () => {
  // Record built with keys in a deliberately scrambled order. The output
  // must still be: pre-auth → auth-rbac → pre-model-deterministic →
  // model-llm → post-model-fallback → execute → emit-events → shape-response
  const stages = buildPhasePipeline("test", {
    [Phase.ShapeResponse]: [namedStage("shape")],
    [Phase.PreAuth]: [namedStage("pre-auth")],
    [Phase.Execute]: [namedStage("execute")],
    [Phase.ModelLlm]: [namedStage("model")],
    [Phase.AuthRbac]: [namedStage("auth")],
    [Phase.EmitEvents]: [namedStage("events")],
    [Phase.PreModelDeterministic]: [namedStage("pre-model")],
    [Phase.PostModelFallback]: [namedStage("fallback")],
  });

  const order = stages.map((s) => s.name);
  assert.deepEqual(order, [
    "pre-auth",
    "auth",
    "pre-model",
    "model",
    "fallback",
    "execute",
    "events",
    "shape",
  ]);
});

test("buildPhasePipeline: throws when a phase key is missing from the input record", () => {
  // Build a record that omits PostModelFallback. The function must throw
  // a message that names the missing phase so contributors can find it.
  const incomplete = {
    [Phase.PreAuth]: [],
    [Phase.AuthRbac]: [],
    [Phase.PreModelDeterministic]: [],
    [Phase.ModelLlm]: [],
    // PostModelFallback intentionally omitted
    [Phase.Execute]: [],
    [Phase.EmitEvents]: [],
    [Phase.ShapeResponse]: [],
  };

  assert.throws(
    () => buildPhasePipeline("test-missing", incomplete),
    /missing phase "post-model-fallback"/,
  );
});
