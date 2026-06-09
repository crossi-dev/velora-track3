// supervisor-stream-context.ts — Per-request SSE chunk callback context.
//
// Carries an optional streaming chunk callback through the async call chain
// without threading it through every function signature.
//
// The SSE streaming wrapper (route-streaming.ts) calls runWithStreamChunkContext
// before invoking handlePost. supervisor-runner.ts reads getStreamChunkCallback()
// inside geminiCall and forwards it to supervisor-agent.ts so partial ADK events
// and Gemini stream chunks are emitted as { kind: "chunk", text } SSE frames.
//
// AsyncLocalStorage propagates automatically through async/await and
// Promise-based call chains in Node.js (AsyncResource context).
// Ref: https://nodejs.org/docs/latest/api/async_context.html#class-asynclocalstorage

import { AsyncLocalStorage } from "async_hooks";

export type StreamChunkCallback = (text: string) => void;

const _chunkCallbackStore = new AsyncLocalStorage<StreamChunkCallback>();

/**
 * Run `fn` with `callback` available to all async descendants via
 * getStreamChunkCallback(). Called by the SSE streaming wrapper before
 * invoking handlePost so supervisor chunk events surface as SSE frames.
 */
export function runWithStreamChunkContext<T>(
  callback: StreamChunkCallback,
  fn: () => T,
): T {
  return _chunkCallbackStore.run(callback, fn);
}

/** Returns the in-flight chunk callback, or null on the non-SSE path. */
export function getStreamChunkCallback(): StreamChunkCallback | null {
  return _chunkCallbackStore.getStore() ?? null;
}
