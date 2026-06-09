"use client";

/**
 * Reads an SSE response from /api/business-assistant.
 *
 * Events expected:
 *   event: ack      — immediate acknowledgement, no action needed
 *   data: { kind: "chunk", text }          — W4 incremental token delta
 *   data: { kind: "final", payload: {...} } — W4 final full response payload
 *   data: { type: "complete", payload: {...} } — legacy final (non-streaming path)
 *   event: error    — {"type":"error","message":"..."}
 *
 * Falls back to plain JSON parsing when the response is not SSE
 * (e.g. idempotency cache replays, rate-limit responses).
 *
 * W4 streaming: when the server emits chunk frames, the onChunk callback is
 * called for each delta so the caller can render a streaming bubble. When the
 * final frame arrives (kind: "final" or type: "complete") the full payload is
 * returned as before. Callers that don't pass onChunk still work unchanged.
 */
export async function readAssistantSSE(
  res: Response,
  fallback: string,
  onChunk?: (text: string) => void,
  /** Called once when the first `event: ack` is received — use to clear a TTFT timer. */
  onAck?: () => void,
): Promise<Record<string, unknown>> {
  if (!res.ok) {
    // 401 — session expired mid-use. Redirect to login rather than showing a
    // raw error code. Using replace() so the back button doesn't loop back to
    // the authenticated page.
    if (res.status === 401 && typeof window !== "undefined") {
      window.location.replace("/?session_expired=1");
      // Return a pending promise — the redirect will navigate away before
      // any caller processes this value.
      return new Promise(() => undefined);
    }
    const text = await res.text().catch(() => "");
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(text); } catch { /* ignore */ }
    throw new Error(typeof body.message === "string" ? body.message : fallback);
  }

  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    const text = await res.text().catch(() => "");
    if (!text) return {};
    try { return JSON.parse(text) as Record<string, unknown>; }
    catch { throw new Error(fallback); }
  }

  if (!res.body) throw new Error(fallback);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  // Fix #8: SSE stall detector — abort if no chunk arrives within 12s after
  // the ack. The outer fetchWithTimeout guards the overall request (42s);
  // this catches the narrower case where the server acks but then hangs
  // mid-stream (e.g. Gemini streaming stall, Cloud Run mid-response freeze).
  // Ref: MDN AbortController (2026), WHATWG Streams stall detection.
  const SSE_STALL_MS = 12_000;
  let ackReceived = false;
  let stallTimer: ReturnType<typeof setTimeout> | null = null;
  const stallController = new AbortController();

  const armStall = () => {
    if (stallTimer !== null) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      if (ackReceived) stallController.abort("sse-stall");
    }, SSE_STALL_MS);
  };

  try {
    while (true) {
      if (stallController.signal.aborted) {
        throw new DOMException("SSE stream stalled after ack", "AbortError");
      }
      const { done, value } = await reader.read();
      armStall(); // reset stall window on every chunk
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      const lines = buf.split("\n");
      buf = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const raw = line.slice(6).trim();
        if (!raw) continue;

        let ev: {
          type?: string;
          kind?: string;
          payload?: Record<string, unknown>;
          message?: string;
          text?: string;
        };
        try { ev = JSON.parse(raw); } catch { continue; }

        // W4: incremental token delta — forward to streaming bubble handler.
        if (ev.kind === "chunk") {
          if (typeof ev.text === "string" && ev.text.length > 0) {
            onChunk?.(ev.text);
          }
          continue;
        }

        // W4: final frame — returns full payload (replaces streaming bubble).
        if (ev.kind === "final") {
          if (stallTimer !== null) clearTimeout(stallTimer);
          return ev.payload ?? {};
        }

        // Legacy: non-streaming fast-path complete envelope.
        if (ev.type === "complete") {
          if (stallTimer !== null) clearTimeout(stallTimer);
          return ev.payload ?? {};
        }
        if (ev.type === "error") {
          if (stallTimer !== null) clearTimeout(stallTimer);
          throw new Error(ev.message ?? fallback);
        }
        // "ack" — arm the stall window post-ack so brief pauses before
        // the first data chunk don't trip the timer. Also clears the TTFT
        // controller so the outer AbortSignal.any() does not abort the fetch.
        if (ev.type === "ack") {
          ackReceived = true;
          onAck?.();
          armStall();
        }
      }
    }
  } finally {
    if (stallTimer !== null) clearTimeout(stallTimer);
    reader.releaseLock();
  }

  throw new Error(fallback);
}
