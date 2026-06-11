"use client";
// JudgeQuerySection — "Run a live Agent Engine query" button for judges.
// Calls /api/public/judge-query (GET, no auth, server-side Agent Engine call).
// The query is hardcoded server-side; this component just triggers + renders.

import { useState } from "react";

interface QueryResult {
  status?: "warming_up" | "rate_limited";
  model?: string;
  toolCall?: string;
  toolResponse?: string;
  answer?: string;
  resourcePath?: string;
  error?: string;
}

const s = {
  section: {
    marginTop: "3rem",
    background: "linear-gradient(135deg, #f8f9ff 0%, #f0f7ff 100%)",
    border: "1px solid #d0e4ff",
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
    margin: "0 0 0.5rem",
    color: "#1a1a1a",
  } as const,
  p: {
    color: "#444",
    fontSize: "0.9375rem",
    margin: "0 0 1rem",
    lineHeight: 1.6,
  } as const,
  button: {
    display: "inline-block",
    background: "#1a73e8",
    color: "white",
    padding: "0.875rem 1.5rem",
    borderRadius: "8px",
    fontSize: "1rem",
    fontWeight: 600,
    border: "none",
    cursor: "pointer",
    transition: "opacity 0.15s",
  } as const,
  buttonDisabled: {
    display: "inline-block",
    background: "#aaa",
    color: "white",
    padding: "0.875rem 1.5rem",
    borderRadius: "8px",
    fontSize: "1rem",
    fontWeight: 600,
    border: "none",
    cursor: "not-allowed",
  } as const,
  loadingText: {
    marginTop: "1rem",
    color: "#555",
    fontSize: "0.9375rem",
    fontStyle: "italic" as const,
  } as const,
  result: {
    marginTop: "1.25rem",
    background: "#1a1a1a",
    color: "#e8e8e8",
    borderRadius: "8px",
    padding: "1rem",
    fontSize: "0.8125rem",
    lineHeight: 1.6,
    fontFamily: "ui-monospace, SFMono-Regular, monospace",
    overflowX: "auto" as const,
  } as const,
  resultRow: {
    margin: "0 0 0.5rem",
  } as const,
  resultKey: {
    color: "#7ec8f7",
    fontWeight: 600,
  } as const,
  resultVal: {
    color: "#e8e8e8",
  } as const,
  caption: {
    marginTop: "0.75rem",
    color: "#666",
    fontSize: "0.8125rem",
  } as const,
  errorBox: {
    marginTop: "1rem",
    background: "#fff3cd",
    border: "1px solid #ffc107",
    borderRadius: "6px",
    padding: "0.75rem",
    fontSize: "0.875rem",
    color: "#664d03",
  } as const,
};

export function JudgeQuerySection() {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<QueryResult | null>(null);

  async function handleQuery() {
    setLoading(true);
    setResult(null);
    try {
      const res = await fetch("/api/public/judge-query");
      const data = (await res.json()) as QueryResult;
      setResult(data);
    } catch {
      setResult({ error: "Network error — check browser console." });
    } finally {
      setLoading(false);
    }
  }

  return (
    <section style={s.section}>
      <span style={s.badge}>LIVE — Vertex AI Agent Engine</span>
      <h2 style={s.h2}>Run a live Agent Engine query →</h2>
      <p style={s.p}>
        This button calls{" "}
        <code>/api/public/judge-query</code> (no auth required). The server authenticates
        with Application Default Credentials (Cloud Run service account), sends a
        fixed catalog search query to{" "}
        <strong>Vertex AI Agent Engine</strong> reasoning engine{" "}
        <code>projects/my-gcp-project/locations/us-central1/reasoningEngines/&lt;id&gt;</code>,
        and returns the real response — including which MCP tool was called and what the
        Agent Engine returned. Cold start can take ~10s.
      </p>

      <button
        style={loading ? s.buttonDisabled : s.button}
        onClick={handleQuery}
        disabled={loading}
      >
        {loading ? "Calling Vertex AI Agent Engine — cold start ~10s…" : "Run live Agent Engine query →"}
      </button>

      {loading && (
        <p style={s.loadingText}>
          Calling Vertex AI Agent Engine — authenticating with ADC, streaming response…
        </p>
      )}

      {result && !result.error && result.status !== "warming_up" && result.status !== "rate_limited" && (
        <div style={s.result}>
          {result.model && (
            <p style={s.resultRow}>
              <span style={s.resultKey}>model: </span>
              <span style={s.resultVal}>{result.model}</span>
            </p>
          )}
          {result.toolCall && (
            <p style={s.resultRow}>
              <span style={s.resultKey}>tool_call: </span>
              <span style={s.resultVal}>{result.toolCall}</span>
            </p>
          )}
          {result.toolResponse && (
            <p style={s.resultRow}>
              <span style={s.resultKey}>tool_response: </span>
              <span style={s.resultVal}>{result.toolResponse}</span>
            </p>
          )}
          {result.answer && (
            <p style={s.resultRow}>
              <span style={s.resultKey}>answer: </span>
              <span style={s.resultVal}>{result.answer}</span>
            </p>
          )}
          {result.resourcePath && (
            <p style={s.resultRow}>
              <span style={s.resultKey}>resource: </span>
              <span style={{ ...s.resultVal, fontSize: "0.75rem" }}>{result.resourcePath}</span>
            </p>
          )}
        </div>
      )}

      {result?.status === "warming_up" && (
        <div style={s.errorBox}>
          Agent Engine is warming up (Cloud Run cold start). Wait ~15s and try again.
        </div>
      )}

      {result?.status === "rate_limited" && (
        <div style={s.errorBox}>
          Rate limited — max 1 request per 30 seconds per IP. Please wait a moment.
        </div>
      )}

      {result?.error && (
        <div style={s.errorBox}>
          Error: {result.error}
        </div>
      )}

      {result && (
        <p style={s.caption}>
          Full resource path:{" "}
          <code>
            projects/my-gcp-project/locations/us-central1/reasoningEngines/&lt;id&gt;
          </code>
          {" — live id at somosvelora.com/track3 — "}
          <a
            href="https://github.com/crossi-dev/velora-track3/tree/main/agent-engine"
            style={{ color: "#1a73e8", fontSize: "0.8125rem" }}
            target="_blank"
            rel="noopener noreferrer"
          >
            agent-engine/ source
          </a>
        </p>
      )}
    </section>
  );
}
