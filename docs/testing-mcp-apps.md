# Testing Velora's MCP tools and widgets

Velora is a **remote** MCP server (`tools.somosvelora.com/api/mcp`), already
deployed — this is simpler than the local-stdio-server workflow Anthropic's
docs lead with, because there's no tunnel step. Sources: claude.com/docs/
connectors/building/testing.md and mcp-apps/getting-started.md (fetched
2026-07-27; re-check if this file goes stale).

## Add Velora as a custom connector

Any Claude account (Free through Enterprise) can add a custom connector —
this uses the exact same runtime a directory-listed connector would, so
what works here works after publication:

1. Claude.ai / Claude Desktop → **Settings → Connectors → Add custom
   connector**.
2. Enter `https://tools.somosvelora.com/api/mcp`.
3. Complete the OAuth flow (WorkOS-hosted) when prompted.
4. Ask Claude to use a Velora tool by name, e.g. "mostrame mi negocio" or
   "abrí el selector de catálogo" — Claude will ask permission to render
   the widget the first time; click "Always allow".

There is no separate staging environment. Testing against the live
`tools.somosvelora.com` deployment *is* the recommended workflow — just be
aware you're hitting real production data for whichever test business
you're authenticated as.

## Inspecting a widget when something looks wrong

- **Claude Desktop**: Settings → Developer → enable Developer Mode →
  `Cmd/Ctrl+Shift+I` opens Chrome DevTools. Find the tool-call element and
  look for an iframe nested inside another iframe — the widget is the
  content of the *inner* iframe. This is the only way to read a widget's
  own `console.log` output or inspect its CSP — the widget iframe is a
  different origin (`*.claudemcpcontent.com`) than the host page, so
  browser-extension-driven automation tools that only see the top-level
  page (e.g. `claude-in-chrome`'s console/network readers) cannot see
  inside it. Confirmed the hard way — see
  `docs/TODO-widget-initiated-tool-call-no-render.md`.
- **Claude.ai web**: no equivalent widget-iframe inspector is documented.
  If you need to see inside the widget, use Claude Desktop instead.

## Verifying a tool call actually reached Velora

Since MCP tool calls are proxied through Claude's backend (they never show
up as a browser network request — see
`docs/TODO-widget-initiated-tool-call-no-render.md` for the full story),
check Velora's own Cloud Run logs instead:

```bash
gcloud logging read 'resource.type="cloud_run_revision" resource.labels.service_name="velora" httpRequest.requestUrl:"/api/mcp"' \
  --limit=10 --format="table(timestamp,httpRequest.status,httpRequest.requestUrl)" --freshness=10m
```

Match the timestamp against when you clicked/asked. A `200` with a
non-trivial `responseSize` means the render tool ran and returned real
data — even if nothing visibly changed in the chat.

## MCP Inspector (protocol-level checks)

For schema/protocol validation independent of Claude's rendering —
[MCP Inspector](https://modelcontextprotocol.io/docs/tools/inspector) can
connect directly to `tools.somosvelora.com/api/mcp` and exercise the OAuth
flow, list tools, and call them without going through Claude at all. Useful
for isolating "is this a Velora bug" from "is this a Claude host bug"
(exactly the distinction that mattered for the tool-chaining issue above).

## Reporting a suspected Claude-host bug

If a tool call clearly succeeds server-side (per the Cloud Run log check
above) but nothing renders, that's a Claude-host issue, not a Velora bug —
file it to **mcp-apps@anthropic.com** (Anthropic's own listed feedback
address for MCP Apps, per getting-started.md) rather than continuing to
debug it from this repo.
