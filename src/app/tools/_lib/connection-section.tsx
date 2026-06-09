// src/app/tools/_lib/connection-section.tsx — Connection section for the tools landing.
// Extracted from page.tsx to stay under the 300-line file limit.

const AUTH_HEADERS = [
  { header: "x-api-key", desc: "Clave de API por tenant. Enviada en cada request." },
  { header: "x-business-id", desc: "Identificador del negocio. Determina el tenant activo." },
] as const;

export function ConnectionSection() {
  return (
    <section style={{ marginBottom: "3rem" }}>
      <h2
        style={{
          fontSize: "clamp(1.25rem, 3vw, 1.625rem)",
          fontWeight: 600,
          lineHeight: 1.25,
          margin: "0 0 1.25rem",
          color: "#e8e8f0",
        }}
      >
        Cómo conectarse
      </h2>

      {/* Claude Code / API keys */}
      <h3 style={{ fontSize: "1.125rem", fontWeight: 600, color: "#c4b5fd", margin: "0 0 0.625rem", lineHeight: 1.3 }}>
        Claude Code (headers HTTP)
      </h3>
      <p style={{ fontSize: "1rem", color: "#d1d5db", margin: "0 0 0.75rem", lineHeight: 1.5 }}>
        Endpoint del servidor MCP (Streamable HTTP, stateless):
      </p>
      <div
        style={{
          background: "rgba(255,255,255,0.04)",
          border: "1px solid rgba(255,255,255,0.1)",
          borderRadius: "0.5rem",
          padding: "1rem 1.25rem",
          fontFamily: "monospace",
          fontSize: "0.9375rem",
          color: "#a5b4fc",
          overflowX: "auto",
          marginBottom: "1rem",
          wordBreak: "break-all",
        }}
      >
        https://tools.somosvelora.com/api/mcp
      </div>
      <p style={{ fontSize: "1rem", color: "#d1d5db", margin: "0 0 0.75rem" }}>
        Autenticación por headers HTTP en cada request (credenciales por tenant):
      </p>
      <div
        style={{
          overflowX: "auto",
          border: "1px solid rgba(255,255,255,0.08)",
          borderRadius: "0.5rem",
          marginBottom: "2rem",
        }}
      >
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.9375rem", minWidth: "24rem" }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left", padding: "0.625rem 1rem", background: "rgba(255,255,255,0.05)", color: "#9ca3af", fontWeight: 600, width: "40%" }}>
                Header
              </th>
              <th style={{ textAlign: "left", padding: "0.625rem 1rem", background: "rgba(255,255,255,0.05)", color: "#9ca3af", fontWeight: 600 }}>
                Descripción
              </th>
            </tr>
          </thead>
          <tbody>
            {AUTH_HEADERS.map((row, i) => (
              <tr key={row.header}>
                <td style={{ padding: "0.625rem 1rem", background: i % 2 === 0 ? "rgba(255,255,255,0.02)" : "transparent", fontFamily: "monospace", color: "#c4b5fd", borderTop: "1px solid rgba(255,255,255,0.06)" }}>
                  {row.header}
                </td>
                <td style={{ padding: "0.625rem 1rem", background: i % 2 === 0 ? "rgba(255,255,255,0.02)" : "transparent", color: "#d1d5db", borderTop: "1px solid rgba(255,255,255,0.06)" }}>
                  {row.desc}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* OAuth 2.1 — hosted clients */}
      <h3 style={{ fontSize: "1.125rem", fontWeight: 600, color: "#c4b5fd", margin: "0 0 0.625rem", lineHeight: 1.3 }}>
        Conectar con OAuth (Cowork · Desktop · claude.ai)
      </h3>
      <p style={{ fontSize: "1rem", color: "#d1d5db", margin: "0 0 0.75rem", lineHeight: 1.5 }}>
        Los clientes MCP alojados (Cowork, Claude Desktop, claude.ai) se conectan mediante{" "}
        <strong style={{ color: "#e8e8f0" }}>OAuth 2.1</strong> — el estándar de autorización
        delegada recomendado por la spec MCP 2025-11-05. El flujo es:
      </p>
      <ol style={{ margin: "0 0 1rem", paddingLeft: "1.5rem", fontSize: "1rem", color: "#d1d5db", lineHeight: 1.75 }}>
        <li>
          El cliente descubre el authorization server mediante{" "}
          <code style={{ fontFamily: "monospace", color: "#a5b4fc", fontSize: "0.9375rem" }}>
            /.well-known/oauth-protected-resource
          </code>{" "}
          (RFC 9728).
        </li>
        <li>El usuario autoriza una sola vez en el flujo OAuth estándar (code + PKCE).</li>
        <li>
          El cliente recibe un{" "}
          <strong style={{ color: "#e8e8f0" }}>access token</strong> y lo envía en el header{" "}
          <code style={{ fontFamily: "monospace", color: "#a5b4fc", fontSize: "0.9375rem" }}>Authorization: Bearer &lt;token&gt;</code>{" "}
          en cada request al servidor MCP.
        </li>
      </ol>
      <p style={{ fontSize: "0.9375rem", color: "#6b7280", margin: 0, lineHeight: 1.5 }}>
        Las credenciales OAuth (client ID, authorization server URL) son configuradas por el
        administrador del negocio — no son valores públicos fijos.
      </p>
    </section>
  );
}
