// supervisor-runner.gemini-direct.ts — Direct-Gemini fallback helpers.
// Extracted from supervisor-runner.ts to keep that file under the 300-line limit.
//
// callFlashFallback: fires when Pro is rate-limited; runs Flash as a safety net.
// callGeminiDirect: direct sendMessage or sendMessageStream (SSE streaming path).

import { cloudLog } from "@/lib/cloud-logger";
import {
  getGeminiSupervisorModel,
  getGeminiSupervisorModelMinimal,
  getGeminiModel,
} from "@/app/api/business-assistant/_lib/gemini-client";
import type { StreamChunkCallback } from "./supervisor-stream-context";

// Local Content type mirrors TextPart | InlinePart union from gemini-client.ts.
// Using a discriminated-union-compatible shape so the two types are structurally
// assignable when TypeScript resolves the `history` parameter in startChat.
type TextPart = { text: string };
type InlinePart = { inlineData: { mimeType: string; data: string } };
type MsgPart = TextPart | InlinePart;
type Content = { role: "user" | "model"; parts: MsgPart[] };

// Per-attempt timeout — read at call time to respect runtime overrides.
function attemptTimeoutMs(): number {
  return Number(process.env.SUPERVISOR_ATTEMPT_TIMEOUT_MS ?? "12000");
}

/** Flash fallback called when the Pro model returns a 429 rate-limit error. */
export async function callFlashFallback(opts: {
  systemPrompt: string;
  userMessage: string;
  geminiHistory: Content[];
  bizId: string;
}): Promise<string> {
  cloudLog({
    severity: "WARNING", component: "Supervisor", action: "SUPERVISOR_FLASH_FALLBACK",
    a2a_transfer: false, message: "Pro rate-limited — falling back to Flash for this turn",
    businessId: opts.bizId, data: {},
  });
  const chat = getGeminiModel().startChat({
    systemInstruction: opts.systemPrompt,
    history: opts.geminiHistory,
  });
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(
      () => reject(Object.assign(new Error("Flash fallback timed out"), { name: "TimeoutError" })),
      attemptTimeoutMs(),
    ),
  );
  const result = await Promise.race([chat.sendMessage([{ text: opts.userMessage }]), timeout]);
  const parts = result.response.candidates?.[0]?.content?.parts ?? [];
  return parts.map(p => p.text).filter((t): t is string => typeof t === "string" && t.length > 0).at(-1) ?? "";
}

/**
 * Direct-Gemini call (bypasses ADK).
 * When onChunk is provided (SSE path) uses sendMessageStream so tokens are
 * forwarded to the client incrementally; otherwise buffers the full response.
 */
export async function callGeminiDirect(opts: {
  systemPrompt: string;
  userMessage: string;
  geminiHistory: Content[];
  isSimple: boolean;
  onChunk?: StreamChunkCallback;
}): Promise<string> {
  const model = opts.isSimple ? getGeminiSupervisorModelMinimal() : getGeminiSupervisorModel();
  const chat = model.startChat({
    systemInstruction: opts.systemPrompt,
    history: opts.geminiHistory,
  });
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(
      () => reject(Object.assign(new Error("Supervisor call timed out"), { name: "TimeoutError" })),
      attemptTimeoutMs(),
    ),
  );

  // SSE path: stream tokens via sendMessageStream.
  if (opts.onChunk) {
    const streamResult = await Promise.race([
      chat.sendMessageStream([{ text: opts.userMessage }]),
      timeout,
    ]);
    let fullText = "";
    for await (const chunk of streamResult.stream) {
      const chunkParts = chunk.candidates?.[0]?.content?.parts ?? [];
      const delta = chunkParts
        .map((p: { text?: string }) => p.text)
        .filter((t): t is string => typeof t === "string" && t.length > 0)
        .join("");
      if (delta) { fullText += delta; opts.onChunk(delta); }
    }
    return fullText;
  }

  // Non-SSE path: single buffered call.
  const result = await Promise.race([chat.sendMessage([{ text: opts.userMessage }]), timeout]);
  const parts = result.response.candidates?.[0]?.content?.parts ?? [];
  return parts.map(p => p.text).filter((t): t is string => typeof t === "string" && t.length > 0).at(-1) ?? "";
}
