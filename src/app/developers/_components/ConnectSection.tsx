// src/app/developers/_components/ConnectSection.tsx — Endpoint, connector
// config snippet, and the request-access CTA.
//
// The config block reuses the dot-chrome header motif from the hero's laptop
// mockup and the widget shelf's card chrome, so the three sections read as
// one designed system instead of three unrelated blocks.

const REQUEST_ACCESS_EMAIL = "gestiones@somosvelora.com";

interface ConfigLine {
  text: string;
  indent: number;
}

// Manually tokenized (not dangerouslySetInnerHTML) so JSON keys/strings get a
// restrained two-tone treatment without pulling in a syntax-highlighter dependency.
const CONFIG_LINES: ConfigLine[] = [
  { text: "{", indent: 0 },
  { text: '"mcpServers": {', indent: 1 },
  { text: '"velora": {', indent: 2 },
  { text: '"type": "http",', indent: 3 },
  { text: '"url": "https://tools.somosvelora.com/api/mcp",', indent: 3 },
  { text: '"headers": {', indent: 3 },
  { text: '"X-API-Key": "<your-key>",', indent: 4 },
  { text: '"X-Business-Id": "<your-business-id>"', indent: 4 },
  { text: "}", indent: 3 },
  { text: "}", indent: 2 },
  { text: "}", indent: 1 },
  { text: "}", indent: 0 },
];

function ConfigLineRow({ line }: { line: ConfigLine }) {
  const parts = line.text.split(/("(?:[^"\\]|\\.)*")/g).filter(Boolean);
  return (
    <div style={{ paddingLeft: `${line.indent * 1.1}rem` }}>
      {parts.map((part, i) =>
        part.startsWith('"') ? (
          <span key={i} style={{ color: "var(--brand)" }}>
            {part}
          </span>
        ) : (
          <span key={i} style={{ color: "var(--tone-body)" }}>
            {part}
          </span>
        ),
      )}
    </div>
  );
}

export function ConnectSection() {
  return (
    <section aria-labelledby="connect-headline" className="border-t border-[color:var(--border)] py-12 md:py-16">
      <p className="m-0 mb-2 text-[0.8125rem] font-semibold uppercase tracking-[0.08em] text-[color:var(--tone-muted)]">
        Conectate
      </p>
      <h2
        id="connect-headline"
        className="m-0 mb-6 font-[family-name:var(--font-fraunces)] font-medium leading-[1.15] tracking-[-0.015em] text-[color:var(--tone-strong)]"
        style={{ fontSize: "clamp(1.625rem, 3vw, 2.25rem)" }}
      >
        Un endpoint, cualquier cliente MCP.
      </h2>

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
        <div>
          <p className="m-0 mb-2 text-[0.9375rem] leading-[1.6] text-[color:var(--tone-body)]">
            Endpoint MCP (Streamable HTTP):
          </p>
          <div className="mb-5 overflow-x-auto rounded-[var(--radius-md)] border border-[color:var(--border)] bg-[color:var(--surface-subtle)] px-4 py-3">
            <code className="whitespace-nowrap font-[family-name:var(--font-mono)] text-[0.9375rem] text-[color:var(--brand)]">
              https://tools.somosvelora.com/api/mcp
            </code>
          </div>

          <p className="m-0 mb-2 text-[0.9375rem] leading-[1.6] text-[color:var(--tone-body)]">
            Config para agregarlo como conector personalizado:
          </p>
          <div className="mb-5 overflow-hidden rounded-[var(--radius-md)] border border-[color:var(--border)]">
            <div className="flex items-center gap-1.5 border-b border-[color:var(--border)] bg-[color:var(--surface)] px-3 py-2">
              <span className="h-2 w-2 rounded-full" style={{ background: "#E17B6B" }} />
              <span className="h-2 w-2 rounded-full" style={{ background: "#E0BA5E" }} />
              <span className="h-2 w-2 rounded-full" style={{ background: "#5FAE7D" }} />
              <span className="ml-1.5 truncate font-[family-name:var(--font-mono)] text-[0.6875rem] text-[color:var(--tone-faint)]">
                connector.json
              </span>
            </div>
            <pre className="m-0 overflow-x-auto bg-[color:var(--surface-subtle)] p-4">
              <code className="font-[family-name:var(--font-mono)] text-[0.8125rem] leading-[1.7]">
                {CONFIG_LINES.map((line, i) => (
                  <ConfigLineRow key={i} line={line} />
                ))}
              </code>
            </pre>
          </div>

          <p className="m-0 max-w-[58ch] text-[0.875rem] leading-[1.6] text-[color:var(--tone-muted)]">
            Autenticación por API key (HMAC, headers <code className="font-[family-name:var(--font-mono)]">X-API-Key</code> /{" "}
            <code className="font-[family-name:var(--font-mono)]">X-Business-Id</code>) o por OAuth 2.1 para clientes
            alojados. Gratis durante el acceso anticipado.
          </p>
        </div>

        <aside className="flex flex-col rounded-[var(--radius-lg)] border border-[color:var(--border)] bg-[color:var(--surface)] p-6 shadow-[var(--shadow-sm)]">
          <p className="m-0 mb-1 text-[0.8125rem] font-semibold uppercase tracking-[0.06em] text-[color:var(--tone-muted)]">
            MCP Registry
          </p>
          <p className="m-0 mb-4 text-[0.9375rem] leading-[1.6] text-[color:var(--tone-body)]">
            Publicado en el registro oficial del protocolo como{" "}
            <code className="font-[family-name:var(--font-mono)] text-[0.8125rem]">com.somosvelora/velora</code>, versión
            1.0.1, activo.
          </p>
          <a
            href="https://registry.modelcontextprotocol.io"
            target="_blank"
            rel="noopener noreferrer"
            className="mb-6 inline-block text-[0.875rem] text-[color:var(--brand)] underline decoration-[color:var(--border-strong)] underline-offset-4"
          >
            registry.modelcontextprotocol.io &rarr;
          </a>

          <div className="mt-auto border-t border-[color:var(--border)] pt-5">
            <a
              href={`mailto:${REQUEST_ACCESS_EMAIL}?subject=${encodeURIComponent("Acceso anticipado — Velora MCP")}`}
              className="inline-flex w-full items-center justify-center rounded-[var(--radius-pill)] bg-[color:var(--action-primary-bg)] px-5 py-3 text-[0.9375rem] font-semibold text-[color:var(--action-primary-fg)] transition-opacity hover:opacity-90"
            >
              Pedir acceso
            </a>
          </div>
        </aside>
      </div>
    </section>
  );
}
