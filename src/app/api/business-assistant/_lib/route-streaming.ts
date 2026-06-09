// route-streaming.ts — SSE streaming wrapper + empty-answer guard for
// the business-assistant route. Extracted from route.ts to keep that file
// under the 300-line server limit.
//
// W4 SSE streaming (2026-05-27):
// The streaming wrapper now wires a per-request chunk callback into the
// supervisor call chain via AsyncLocalStorage (runWithStreamChunkContext in
// supervisor-runner.ts). As the ADK event loop produces partial text events
// (or the direct-Gemini path yields sendMessageStream chunks), each delta is
// forwarded as a { kind: "chunk", text } SSE frame so the client can render
// tokens incrementally.
//
// SSE frame contract:
//   event: ack      — immediate auth-passed ack, no action needed
//   data: { kind: "chunk", text: "<delta>" }   — incremental token delta
//   data: { kind: "final", payload: {...} }    — final full response payload
//   data: { type: "complete", payload: {...} } — legacy alias for final (non-streaming path)
//   event: error    — { type: "error", message: "...", code: "..." }
//
// Client: useAssistantStreaming / utils.sse.ts handles both legacy "complete"
// and new "chunk"/"final" frames so the non-streaming fallback still works.

import { NextRequest, NextResponse } from "next/server";
import { cloudLog, runWithTraceContext } from "@/lib/cloud-logger";
import { handleAssistantRouteError } from "./error-handler";
import { resolveActor } from "@/app/api/_lib/resolve-actor";
import { runWithStreamChunkContext } from "@/app/api/supervisor/_lib/supervisor-stream-context";

const _enc = new TextEncoder();
export const _sse = (event: string, data: unknown) =>
  _enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

// Empty-answer guard shared by `respond` and `cacheAndReturn`.
// Returns a patched NextResponse when a successful reply carries a blank
// `answer` field; otherwise returns the original response unchanged.
export async function patchEmptyAnswer(res: NextResponse, businessId: string, inputText: string): Promise<NextResponse> {
  if (!res.ok || res.status < 200 || res.status >= 300) return res;
  try {
    const body = (await res.clone().json()) as Record<string, unknown>;
    if (!("answer" in body)) return res;
    const answer = typeof body.answer === "string" ? body.answer : "";
    if (answer && answer.trim().length > 0) return res;
    cloudLog({
      severity: "WARNING", component: "System", action: "EMPTY_ANSWER_FALLBACK",
      a2a_transfer: false, message: "empty answer fallback fired",
      businessId, data: { input: inputText.slice(0, 200), keys: Object.keys(body) },
    });
    return NextResponse.json(
      { ...body, answer: "No te entendí bien. ¿Podés decirlo de otra forma? Ejemplo: 'cargar producto X 10 unidades 50 pesos'." },
      { status: res.status },
    );
  } catch { return res; }
}

// C2 fix (Finding 2): handlePost receives a pre-read ArrayBuffer so the
// caller (streaming wrapper OR the non-SSE POST entry) buffers the body
// exactly once. The streaming wrapper clones req.arrayBuffer() before opening
// the SSE stream; handlePost receives it and skips its own arrayBuffer() call.
// This prevents a second read when the platform (middleware, logging, edge
// runtime) has already consumed the raw body stream.
// Ref: https://nextjs.org/docs/app/api-reference/functions/next-request
export type HandlePostFn = (req: NextRequest, preReadBuffer?: ArrayBuffer) => Promise<NextResponse>;

export function buildHandleStreamingPost(handlePost: HandlePostFn, lLmTimeoutMs: number) {
  // C2 fix (Finding 7): resolveActor is called BEFORE the SSE stream is
  // opened. The `ack` event is emitted only after the actor is verified.
  // An unauthenticated client receives a 401 plain response — no SSE stream
  // is opened, so the client cannot infer the endpoint is alive or accepting
  // connections.
  // Ref: OWASP API Security Top 10 2023 API2 — Broken Authentication.
  //      https://www.hahwul.com/sec/web-security/sse/ — "authenticate before stream open"
  return async function handleStreamingPost(req: NextRequest): Promise<Response> {
    // Auth check BEFORE the stream is opened — no ack until the actor is verified.
    const actor = await resolveActor(req);
    if (!actor) {
      return new Response(JSON.stringify({ code: "UNAUTHORIZED", message: "Authentication required." }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    // C2 fix (Finding 2): buffer the request body once here. The streaming
    // path is the SSE-aware entry — we own the request at this point and
    // no other consumer has read the body yet. handlePost receives the buffer
    // and skips its own arrayBuffer() call, eliminating the risk of a second
    // read throwing if the platform already drained the stream.
    let preReadBuffer: ArrayBuffer | undefined;
    try {
      preReadBuffer = await req.arrayBuffer();
    } catch {
      return new Response(JSON.stringify({ code: "INVALID_REQUEST", message: "Invalid request body." }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const stream = new ReadableStream({
      async start(controller) {
        // Track whether the controller was already closed (e.g. by the timeout)
        // so post-timeout enqueue/close attempts don't throw "Controller is already closed".
        let closed = false;
        const safeEnqueue = (chunk: Uint8Array) => { if (!closed) controller.enqueue(chunk); };
        const safeClose = () => { if (!closed) { closed = true; controller.close(); } };

        // Auth passed — safe to emit ack now.
        safeEnqueue(_sse("ack", { type: "ack" }));
        // Mirror the same JS-layer timeout used on the non-SSE path so a slow
        // Gemini Pro call doesn't hang the SSE stream until Cloud Run kills it.
        const timeoutId = setTimeout(() => {
          safeEnqueue(_sse("error", { type: "error", message: "Request timed out. Please try again.", code: "GATEWAY_TIMEOUT" }));
          safeClose();
        }, lLmTimeoutMs);

        // SSE keepalive comment — prevents proxy/CDN idle-timeout disconnects.
        // A colon-only line is an SSE comment; clients ignore it. Sent every 10 s
        // while the LLM is processing so intermediate proxies (e.g. Envoy default
        // stream_idle_timeout=5 min, nginx proxy_read_timeout=60 s) stay alive.
        // MDN SSE: https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events
        const keepaliveId = setInterval(() => {
          safeEnqueue(_enc.encode(": keepalive\n\n"));
        }, 10_000);
        // W4: track whether any chunk was emitted so we choose the right
        // final envelope. If chunks were emitted we send { kind: "final" }
        // so the client replaces the streaming bubble with the durable entry.
        // If no chunks were emitted (e.g. fast-path deterministic reply) we
        // fall back to the legacy { type: "complete" } envelope so existing
        // non-streaming client code paths still work.
        let chunkCount = 0;

        const onChunk = (text: string) => {
          chunkCount++;
          safeEnqueue(_enc.encode(`data: ${JSON.stringify({ kind: "chunk", text })}\n\n`));
        };

        try {
          const res = await runWithTraceContext(req.headers, () =>
            runWithStreamChunkContext(onChunk, () => handlePost(req, preReadBuffer)),
          );
          clearTimeout(timeoutId);
          clearInterval(keepaliveId);
          const body = (await res.clone().json()) as Record<string, unknown>;
          if (res.ok) {
            if (chunkCount > 0) {
              // Streaming path: send final envelope so the client replaces the
              // streaming bubble with the durable assistant entry.
              safeEnqueue(_enc.encode(`data: ${JSON.stringify({ kind: "final", payload: body })}\n\n`));
            } else {
              // Non-streaming path (fast-path handlers, rate-limit replays):
              // keep legacy complete envelope for backward compat.
              safeEnqueue(_sse("complete", { type: "complete", payload: body, status: res.status }));
            }
          } else {
            safeEnqueue(_sse("error", { type: "error", message: body.message ?? "Request failed", code: body.code, status: res.status }));
          }
        } catch (err) {
          clearTimeout(timeoutId);
          clearInterval(keepaliveId);
          // Do NOT forward the raw error message to the client — it may contain
          // internal details. Use the same sanitized response as the non-SSE path.
          const sanitized = handleAssistantRouteError(err);
          const sanitizedBody = await sanitized.json() as { message?: string; code?: string };
          safeEnqueue(_sse("error", { type: "error", message: sanitizedBody.message ?? "Request failed", code: sanitizedBody.code }));
        } finally {
          clearInterval(keepaliveId); // guard: clears even if timeout fired before try/catch
          safeClose();
        }
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
      },
    });
  };
}
