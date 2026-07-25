// src/app/developers/_components/ConnectSection.tsx — Endpoint, connector
// config snippet, and the request-access CTA.

const CONFIG_SNIPPET = `{
  "mcpServers": {
    "velora": {
      "type": "http",
      "url": "https://tools.somosvelora.com/api/mcp",
      "headers": {
        "X-API-Key": "<your-key>",
        "X-Business-Id": "<your-business-id>"
      }
    }
  }
}`;

const REQUEST_ACCESS_EMAIL = "gestiones@somosvelora.com";

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
          <pre className="m-0 mb-5 overflow-x-auto rounded-[var(--radius-md)] border border-[color:var(--border)] bg-[color:var(--surface-subtle)] p-4">
            <code className="font-[family-name:var(--font-mono)] text-[0.8125rem] leading-[1.6] text-[color:var(--tone-body)]">
              {CONFIG_SNIPPET}
            </code>
          </pre>

          <p className="m-0 max-w-[58ch] text-[0.875rem] leading-[1.6] text-[color:var(--tone-muted)]">
            Autenticación por API key (HMAC, headers <code className="font-[family-name:var(--font-mono)]">X-API-Key</code> /{" "}
            <code className="font-[family-name:var(--font-mono)]">X-Business-Id</code>) o por OAuth 2.1 para clientes
            alojados. Gratis durante el acceso anticipado.
          </p>
        </div>

        <aside className="rounded-[var(--radius-lg)] border border-[color:var(--border)] bg-[color:var(--surface)] p-6">
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

          <a
            href={`mailto:${REQUEST_ACCESS_EMAIL}?subject=${encodeURIComponent("Acceso anticipado — Velora MCP")}`}
            className="inline-flex w-full items-center justify-center rounded-[var(--radius-pill)] bg-[color:var(--action-primary-bg)] px-5 py-3 text-[0.9375rem] font-semibold text-[color:var(--action-primary-fg)] transition-opacity hover:opacity-90"
          >
            Pedir acceso
          </a>
        </aside>
      </div>
    </section>
  );
}
