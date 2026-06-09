// Module-scoped FIFO queue of user messages that were submitted while a
// previous chat operation held the in-flight lock. Lives outside any single
// hook so both useAssistantChat (normal flow) AND useAssistantConfirmation
// (confirm card execution) can enqueue/drain consistently.
//
// Why module-scope: the in-flight lock (in-flight-lock.ts) is also module
// scope. When the confirmation hook releases the lock at the end of an
// action, it has no reference to the chat hook's local pendingQueueRef —
// previously this meant messages typed during a confirmation were silently
// dropped at the line `if (isInFlight(businessId)) return`. The shared
// queue lets either release path drain cleanly.

const queue: string[] = [];
let drainHandler: ((text: string) => void) | null = null;

export function enqueuePendingMessage(text: string): void {
  if (!text.trim()) return;
  queue.push(text);
}

export function dequeuePendingMessage(): string | null {
  return queue.shift() ?? null;
}

export function clearPendingMessages(): void {
  queue.length = 0;
}

export function pendingMessageCount(): number {
  return queue.length;
}

// Wires the drain handler. Whoever owns handleGo registers itself here so
// any caller (from any hook) can trigger drainage by name. Replaces the
// previous pattern where drainage only happened in handleGo's finally.
export function registerPendingMessageDrainer(handler: (text: string) => void): () => void {
  drainHandler = handler;
  return () => {
    if (drainHandler === handler) drainHandler = null;
  };
}

// Drain one message — defers to next tick so the caller's state can settle
// before the queued submission re-enters handleGo. Bails if no handler is
// registered so a message isn't lost during a remount window.
export function drainNextPendingMessage(): void {
  if (drainHandler === null || queue.length === 0) return;
  const next = queue.shift();
  if (next === undefined) return;
  const handler = drainHandler;
  setTimeout(() => handler(next), 0);
}
