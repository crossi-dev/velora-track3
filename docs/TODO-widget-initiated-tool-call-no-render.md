# Widget-initiated tool calls succeed server-side but the resulting widget never renders

Confirmed live (2026-07-26): clicking "Cobrar a cliente" in `catalog-selector.tsx`
(calls `open_payment_link_wizard` via `app.callServerTool`) produces no visible
change in the chat — no new widget, no error, no loading state that persists
long enough to notice.

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

## Working theory, not confirmed

The server does its job. The gap looks like it's on Claude's host side:
something about widget-initiated (`app.callServerTool`) tool calls, as
opposed to Claude initiating a tool call from its own turn, may not always
produce a new rendered tool-result turn in the current host version — or
there's a timing/ordering issue between the host receiving the result and
the conversation view updating. This is a *theory*, not verified against any
doc or reproduced with full certainty of the exact mechanism — do not repeat
it as fact without further evidence.

## Not investigated further here

Confirming the exact host-side mechanism would need either:
- Anthropic's own MCP Apps developer tools (claude.com/docs/connectors/
  building/mcp-apps/troubleshooting.md documents a Desktop-only nested-iframe
  inspector via Cmd/Ctrl+Shift+I — not available from this automated
  environment, which drives Claude.ai web), or
- Filing this as feedback/a bug report to Anthropic, since it may be a
  platform behavior outside Velora's control.

Same console.log/iframe-visibility limitation would apply to any other
widget-initiated `callServerTool` flow in this codebase (e.g.
`catalog-selector.tsx`'s own confirm step, `sale-confirm.tsx`'s mutating
buttons) — worth keeping in mind if the same "click succeeds server-side,
nothing visibly happens" pattern shows up elsewhere.
