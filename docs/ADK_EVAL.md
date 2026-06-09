# ADK Evaluation Framework — Velora Integration

Canonical source: **https://adk.dev/evaluate/** (HTTP 200 verified 2026-05-28)
ADK top-level docs: **https://adk.dev/** (HTTP 200 verified 2026-05-28)

---

## What is ADK Eval?

The ADK Evaluation Framework is Google's canonical tool for testing agent comprehension and trajectory correctness. It uses `EvaluationSet` JSON files that define expected tool call trajectories and expected final responses, then scores each case against a live agent run.

Two scoring dimensions:

- **`tool_trajectory_avg_score`** — did the agent call the right tools in the right order?
- **`response_match_score`** — does the agent response semantically match the reference response?

---

## Runtime requirement: Python `google-adk`

**Critical**: the `adk eval` CLI ships with the **Python** implementation of ADK (`pip install google-adk`). The Node.js `@google/adk` package (already a Velora dependency) does not expose an `adk eval` binary. This is not a gap — Google's eval tooling is Python-first by design. The EvaluationSet JSON format is language-agnostic, so Velora's TypeScript agents are evaluated through the Python runner.

```
pip install google-adk
adk eval --help
```

If the Python CLI is not available locally, use a Docker container or Cloud Build step to run evals in CI.

---

## EvaluationSet files

Located in `tests/adk-eval/`:

| File | Eval Set ID | Cases | Covers |
|------|-------------|-------|--------|
| `owner-intents.evalset.json` | `velora-owner-intents-v1` | 12 | Owner/Supervisor AR Spanish: product load, stock query, sale-send, typo variants, multi-price edit, undo, create customer |
| `customer-companion.evalset.json` | `velora-customer-companion-v1` | 13 | Customer/Companion AR Spanish: catalog queries, typo tolerance, address capture (full + CP-only), soft rejections (no discount, no fiado), colloquial queries, multi-turn |

Total: **25 test vectors** across both sets.

---

## Running evals

### Local (Python ADK installed)

```bash
# Install once
pip install google-adk

# Run all eval sets
npm run eval:adk

# Or invoke directly for a single set
adk eval \
  src/lib/adk/supervisor-agent.ts \
  tests/adk-eval/owner-intents.evalset.json \
  --print_detailed_results

# Run selective cases from a set
adk eval \
  src/lib/adk/supervisor-agent.ts \
  "tests/adk-eval/owner-intents.evalset.json:owner-load-product-basic,owner-stock-query-basic"
```

### npm script

```bash
npm run eval:adk
```

This runs both eval sets against `src/lib/adk/supervisor-agent.ts` with detailed output.

---

## EvaluationSet JSON schema

Canonical shape as defined at https://adk.dev/evaluate/:

```json
{
  "eval_set_id": "string",
  "name": "string",
  "description": "string",
  "eval_cases": [
    {
      "eval_id": "string",
      "conversation": [
        {
          "invocation_id": "string (UUID)",
          "user_content": {
            "parts": [{ "text": "string" }],
            "role": "user"
          },
          "final_response": {
            "parts": [{ "text": "string — reference; semantic match, not exact" }],
            "role": null
          },
          "intermediate_data": {
            "tool_uses": [
              { "id": "string", "name": "string", "args": {} }
            ],
            "intermediate_responses": []
          }
        }
      ],
      "session_input": {
        "app_name": "string",
        "user_id": "string",
        "state": {}
      }
    }
  ]
}
```

---

## Extending the eval sets

1. Add a new object to `eval_cases` in the appropriate `.evalset.json` file.
2. Give it a descriptive `eval_id` (kebab-case, prefixed with `owner-` or `customer-`).
3. Set `final_response.parts[0].text` to a **partial reference string** — the scorer uses semantic similarity, not exact match. A prefix is enough.
4. Populate `intermediate_data.tool_uses` only if the agent is expected to call tools — leave the array empty for pure conversational turns.
5. Run `npm run eval:adk` and check `tool_trajectory_avg_score` and `response_match_score`.

---

## References

- ADK Evaluation docs: https://adk.dev/evaluate/
- ADK top-level docs: https://adk.dev/
- ADK Python GitHub: https://github.com/google/adk-python
- ADK JS GitHub: https://github.com/google/adk-js
- PyPI package: https://pypi.org/project/google-adk/
