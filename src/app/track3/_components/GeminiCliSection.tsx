// GeminiCliSection — "Try it with Gemini CLI" block for the Track 3 judge page.
// Shows judges how to connect Gemini CLI to Velora's live MCP server.
//
// The .gemini/settings.json config file lives in the repo root (both main and
// snapshot) with the real demo tenant key so judges can clone and run immediately.

const CODE_SETTINGS = `{
  "mcpServers": {
    "velora": {
      "httpUrl": "https://tools.somosvelora.com/api/mcp",
      "headers": {
        "X-API-Key": "<demo-key-in-repo-.gemini/settings.json>",
        "X-Business-Id": "cmpow3rq70009s601j07xgmf0"
      }
    }
  }
}`;

const CODE_QUICKSTART = `# Install Gemini CLI (requires Node 18+)
npm install -g @google/gemini-cli

# One-time auth — run this first and complete the Google login prompt:
gemini
# (or: export GEMINI_API_KEY=<your-key-from-aistudio.google.com>)

# Clone the public repo (settings.json with demo key is included)
git clone https://github.com/crossi-dev/velora-track3
cd velora-track3

# The .gemini/settings.json file already has the demo tenant key.
# Run headless with auto-approve and Flash model:
gemini --yolo -m gemini-2.5-flash -p "list the products in my catalog"

# Or start interactive mode:
gemini

# Read-only queries to try:
> list the products in my catalog
> find the customer Carla in Velora
> what's the current cash balance?`;

const CODE_ONELINER = `# Alternative: add the MCP server directly (no clone needed)
gemini mcp add velora \\
  --transport http \\
  --url https://tools.somosvelora.com/api/mcp \\
  --header "X-API-Key: <get key from .gemini/settings.json>" \\
  --header "X-Business-Id: cmpow3rq70009s601j07xgmf0"`;

const s = {
  section: {
    marginTop: "3rem",
    background: "#f0f7ff",
    border: "1px solid #c2d9f5",
    borderRadius: "12px",
    padding: "1.5rem",
  } as const,
  badge: {
    display: "inline-block",
    background: "#1a73e8",
    color: "white",
    padding: "0.2rem 0.65rem",
    borderRadius: "999px",
    fontSize: "0.8125rem",
    fontWeight: 600,
    marginBottom: "0.75rem",
  } as const,
  h2: {
    fontFamily: "var(--font-fraunces, Georgia, serif)",
    fontSize: "1.5rem",
    fontWeight: 700,
    margin: "0 0 0.75rem",
    color: "#1a1a1a",
  } as const,
  p: {
    color: "#444",
    fontSize: "0.9375rem",
    margin: "0 0 1rem",
    lineHeight: 1.6,
  } as const,
  label: {
    fontWeight: 600,
    fontSize: "0.875rem",
    color: "#333",
    margin: "0 0 0.35rem",
    display: "block",
  } as const,
  pre: {
    background: "#1a1a1a",
    color: "#e8e8e8",
    borderRadius: "8px",
    padding: "1rem",
    fontSize: "0.8125rem",
    lineHeight: 1.6,
    overflowX: "auto" as const,
    marginBottom: "1rem",
    fontFamily: "ui-monospace, SFMono-Regular, monospace",
  } as const,
  link: {
    color: "#1a73e8",
    fontSize: "0.875rem",
  } as const,
  note: {
    background: "#fff8e1",
    border: "1px solid #ffe082",
    borderRadius: "6px",
    padding: "0.625rem 0.875rem",
    fontSize: "0.875rem",
    color: "#5a4000",
    marginTop: "1rem",
  } as const,
};

export function GeminiCliSection() {
  return (
    <section style={s.section}>
      <span style={s.badge}>NEW — Judge Shortcut</span>
      <h2 style={s.h2}>Try it with Gemini CLI</h2>
      <p style={s.p}>
        Velora&apos;s MCP server exposes 50 live tools (catalog, sales, payments, invoicing,
        logistics) over StreamableHTTP. Any MCP-compatible client can connect. Gemini CLI is the
        fastest way for a judge to run a live tool call in under 2 minutes.
      </p>

      <span style={s.label}>Quick start (clone + run):</span>
      <pre style={s.pre}>{CODE_QUICKSTART}</pre>

      <span style={s.label}>
        What&apos;s in <code>.gemini/settings.json</code> (included in the repo):
      </span>
      <pre style={s.pre}>{CODE_SETTINGS}</pre>

      <span style={s.label}>Alternative — add server directly without cloning:</span>
      <pre style={s.pre}>{CODE_ONELINER}</pre>

      <div style={s.note}>
        <strong>Demo tenant scope:</strong> The{" "}
        <code>X-API-Key</code> in <code>.gemini/settings.json</code> is an HMAC-derived
        key scoped to a single demo business — it cannot read or act on any other tenant.
        Money-path tools (<code>register_sale</code>, <code>emit_invoice</code>) write to the live sandbox —
        please keep it tidy for other judges.
        Use <code>--yolo</code> to auto-approve tool calls and <code>-m gemini-2.5-flash</code> if
        your default model 404s on Vertex.
        The live MCP endpoint is at{" "}
        <a
          href="https://tools.somosvelora.com/api/mcp"
          style={s.link}
          target="_blank"
          rel="noopener noreferrer"
        >
          tools.somosvelora.com/api/mcp
        </a>
        {" "}(source:{" "}
        <a
          href="https://github.com/crossi-dev/velora-track3/blob/main/src/lib/mcp/server.ts"
          style={s.link}
          target="_blank"
          rel="noopener noreferrer"
        >
          src/lib/mcp/server.ts
        </a>
        ).
      </div>
    </section>
  );
}
