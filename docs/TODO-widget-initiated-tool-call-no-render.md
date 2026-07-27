# Widget-initiated tool calls succeed server-side but the resulting widget never renders

Confirmed live (2026-07-26), TWO independent flows, same exact symptom —
this is a systemic pattern, not a one-off bug in one widget's code:

1. `catalog-selector.tsx` → `open_payment_link_wizard` ("Cobrar a cliente" button)
2. `pending-orders.tsx` → `open_cobro_status` ("Ver estado" button)

Both: click produces no visible change in the chat — no new widget, no
error, no loading state that persists long enough to notice. Both: Cloud
Run logs show a matching `POST /api/mcp` at the exact click timestamp,
`200`, with a real non-trivial response body (2.6KB–5KB), not an empty or
error-shaped payload.

An earlier pre-compaction summary in this session claimed the
pending-orders → cobro-status hop had been confirmed working live. That
claim was NOT re-verified before being repeated — when actually re-tested
live just now, it fails the same way. Don't trust that earlier claim;
this doc's live-tested findings supersede it.

## What was actually verified

- The button click itself is not the problem: clean, deliberate, single-click
  reproductions in a fresh single-instance tab confirmed the "+"/quantity
  steppers and "Confirmar selección" work correctly. Earlier failed
  reproductions were traced to clicking before the widget had fully hydrated
  (an automation-timing artifact, not a product bug).
- Checked the browser's Network tab first — found nothing, which is expected
  and not evidence of failure: per Anthropic's own troubleshooting doc
  (claude.com/docs/connectors/building/mcp-apps/troubleshooting.md), "MCP tool
  calls are proxied through Claude's backend and egress from Anthropic's
  published IP ranges, not the user's device" — there is no direct
  browser-to-Velora request to observe for a `callServerTool` call.
- Checked Velora's own Cloud Run request logs (`resource.type="cloud_run_revision"
  resource.labels.service_name="velora"`) for the exact click timestamps.
  Found matching `POST /api/mcp` requests: `200`, ~4s latency, ~5KB response
  body (a real, non-trivial payload — not an empty/error shape). This is
  strong evidence the server-side `open_payment_link_wizard` render tool ran
  successfully and returned a full prefill.
- Tried adding `console.log` instrumentation inside `onCobrarCliente` to
  trace the client-side call lifecycle — this did NOT work as a diagnostic:
  the widget runs inside a cross-origin sandboxed iframe
  (`*.claudemcpcontent.com`), and `read_console_messages`-style browser
  tooling only captures the top-level `claude.ai` page's console, not the
  iframe's. The logging was live but permanently unobservable with the tools
  available; removed after confirming this (see git history for
  commit `cf28ae9` / its revert).

## Working theory, strengthened but still not confirmed

The server does its job, twice, in two unrelated widgets. The gap looks
like it's on Claude's host side: something about widget-initiated
(`app.callServerTool`) tool calls, as opposed to Claude initiating a tool
call from its own turn, may not always produce a new rendered tool-result
turn in the current host version — or there's a timing/ordering issue
between the host receiving the result and the conversation view updating.
Reproducing it in two independent widgets rules out "bug specific to one
tool's code" — it's some shared mechanism (the `App` class / host bridge
behavior), not application logic. Still not confirmed against any doc or
with certainty of the exact mechanism — do not repeat the specific
mechanism as fact without further evidence, but the *pattern itself*
(widget-initiated calls not rendering) is now confirmed twice, not once.

**Practical implication for the product**: any "chain one widget into the
next" flow in Velora — catalog-selector → payment-link-wizard,
pending-orders → cobro-status, and likely others using the same
`callServerTool` pattern — should currently be assumed unreliable. This is
a real gap in "does Velora feel like one integrated system" today, not a
one-off. Owners clicking these buttons get no feedback and no error; the
UX reads as broken even though Velora's own code did its job correctly.

## Not investigated further here

Confirming the exact host-side mechanism would need either:
- Anthropic's own MCP Apps developer tools (claude.com/docs/connectors/
  building/mcp-apps/troubleshooting.md documents a Desktop-only nested-iframe
  inspector via Cmd/Ctrl+Shift+I — not available from this automated
  environment, which drives Claude.ai web), or
- Filing this as feedback/a bug report to **mcp-apps@anthropic.com** —
  Anthropic's own listed feedback address for MCP Apps (getting-started.md),
  since this is a platform behavior outside Velora's control, confirmed
  reproducible in two independent widgets. See docs/testing-mcp-apps.md for
  the general local-testing/debugging workflow this finding came out of.

Same console.log/iframe-visibility limitation would apply to any other
widget-initiated `callServerTool` flow in this codebase (e.g.
`catalog-selector.tsx`'s own confirm step, `sale-confirm.tsx`'s mutating
buttons) — worth keeping in mind if the same "click succeeds server-side,
nothing visibly happens" pattern shows up elsewhere.
