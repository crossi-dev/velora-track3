/**
 * Server-side chat message persistence for /api/business-assistant.
 *
 * CANONICAL PATTERN (2026):
 * Both OpenAI Responses/Conversations API and Vercel AI SDK v5 treat the server
 * as the source of truth for message history. The client may write optimistically,
 * but every turn is also persisted server-side so non-UI triggers (CLI, Cloud
 * Tasks, cron, sub-agents) appear in the owner's chat UI without any client
 * involvement. Concurrent writes from UI + server collapse via the unique
 * constraint on (businessId, clientMessageId) — P2002 on the server-side path
 * means the UI's optimistic write already landed; we skip silently.
 *
 * References:
 *   - Vercel AI SDK v5 server-side persistence:
 *     https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-message-persistence
 *   - OpenAI Conversations API (successor to Assistants threads):
 *     https://developers.openai.com/api/docs/assistants/migration
 *   - GitHub vercel-labs/ai-sdk-persistence-db:
 *     https://github.com/vercel-labs/ai-sdk-persistence-db
 */

import { prisma } from "@/lib/prisma";
import { cloudLog } from "@/lib/cloud-logger";
import { redactPii } from "@/lib/chat-history-redact";
import { createHash } from "crypto";

// ---------------------------------------------------------------------------
// clientMessageId derivation
// ---------------------------------------------------------------------------

/**
 * Derives a stable clientMessageId for the user-input row.
 *
 * Priority:
 *   1. X-Idempotency-Key request header — the UI client always sends this and
 *      uses it as its own clientMessageId when writing to /api/chat-history.
 *      Sharing the key guarantees P2002 collapse between UI + server writes.
 *   2. Stable SHA-256 hash of (businessId, actorUserId, text, epoch-second) —
 *      prevents duplicate rows when concurrent triggers fire within the same
 *      second for the same actor + input.
 */
export function deriveUserClientMessageId(opts: {
  idempotencyKey: string | null;
  businessId: string;
  actorUserId: string;
  text: string;
}): string {
  if (opts.idempotencyKey) return opts.idempotencyKey;
  const epochSecond = Math.floor(Date.now() / 1000);
  return createHash("sha256")
    .update(`${opts.businessId}:${opts.actorUserId}:${opts.text}:${epochSecond}`)
    .digest("hex")
    .slice(0, 32);
}

/**
 * Derives the reply clientMessageId from the user-input one.
 * The `-reply` suffix is the Vercel AI SDK v5 convention for pairing
 * user + assistant rows in the same conversation turn.
 */
export function deriveReplyClientMessageId(userClientMessageId: string): string {
  return `${userClientMessageId}-reply`;
}

// ---------------------------------------------------------------------------
// Visibility mapping
// ---------------------------------------------------------------------------

/**
 * Maps actor role → ChatMessage visibility for writes.
 *
 * - owner input     → "owner_only"  (owner sees it, employees do not)
 * - employee input  → "public"      (owner + employee both see it)
 * - assistant reply → "public"      (visible to both — it is the response)
 *
 * This mirrors the read-side policy in visibility-filter.ts where owner sees
 * "public" + "owner_only" and employee sees "public" + "employee_only".
 */
export function inputVisibility(role: "owner" | "employee"): string {
  return role === "owner" ? "owner_only" : "public";
}

// ---------------------------------------------------------------------------
// Write helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Idempotency-aware user-input scheduling
// ---------------------------------------------------------------------------

/**
 * Awaits user-input persist BEFORE the model call starts.
 *
 * C2 fix: only runs on gateKind "execute", "gate_error", "no_key" (all three
 *         values of the union — the condition is left explicit for clarity even
 *         though it covers every branch).
 * Durability fix (B13): moved from after() to synchronous await so a network
 *         drop mid-stream cannot silently lose the user turn. ~30ms latency
 *         increase accepted in exchange for guaranteed persistence — same
 *         trade-off as scheduleReplyPersist.
 *         Ref: https://nextjs.org/docs/app/api-reference/functions/after
 *
 * Callers: route.ts — extracted here to keep route.ts under 300 LOC.
 */
export async function scheduleUserInputPersist(opts: {
  gateKind: "execute" | "gate_error" | "no_key";
  businessId: string;
  actorUserId: string;
  role: "owner" | "employee";
  clientMessageId: string;
  text: string;
}): Promise<void> {
  await persistUserInput({
    businessId: opts.businessId,
    actorUserId: opts.actorUserId,
    role: opts.role,
    clientMessageId: opts.clientMessageId,
    text: opts.text,
  });
}

/**
 * Awaits assistant reply persist BEFORE response returns.
 *
 * Durability design decision (2026-05-26, reaffirmed 2026-05-27):
 * next/server `after()` was evaluated for async post-response persistence but
 * rejected for Cloud Run. `after()` relies on `Symbol.for('@next/request-context').waitUntil`
 * (nextjs.org/docs/app/api-reference/functions/after). On Cloud Run the Node process
 * is CPU-throttled immediately after the HTTP response is flushed — without a
 * platform-injected `waitUntil` shim in instrumentation.ts, `after()` callbacks
 * run in a throttled context and are silently dropped on container recycle.
 * Awaiting sync adds ~50ms latency but guarantees persistence — same trade-off
 * Stripe uses for receipt persistence (docs.stripe.com/payments/checkout/fulfillment).
 * If a `waitUntil` shim is ever wired in instrumentation.ts, `after()` can be
 * revisited here.
 */
export async function scheduleReplyPersist(opts: {
  businessId: string;
  clientMessageId: string;
  answer: string;
  chips?: unknown;
}): Promise<void> {
  await persistAssistantReply({
    businessId: opts.businessId,
    clientMessageId: opts.clientMessageId,
    answer: opts.answer,
    chips: opts.chips,
  });
}

/**
 * Persists the user-input turn server-side.
 *
 * - Wrapped by scheduleUserInputPersist for route-level use.
 * - P2002 (duplicate key) → silent skip: UI's optimistic write already landed.
 * - Any other error → WARNING log, continue. Must not block the LLM turn.
 */
/**
 * Translates a machine-token chip value (e.g. `enviar_link_pago|+54...|cmp...`)
 * to a user-friendly label so the chat history reads as a conversation, not
 * as raw protocol tokens. Per Vercel AI SDK v5 useChat canonical 2026:
 * "chip submit_text is for the LLM, display_text is for the chat UI" —
 * Velora's pattern stores submit_text as the persisted message, so we
 * transform here at the persist boundary.
 */
function humanizeChipToken(text: string): string {
  if (text.startsWith("enviar_link_pago|")) {
    const parts = text.split("|");
    const phone = parts[1] ?? "";
    return phone ? `📲 Enviar link al ${phone}` : "📲 Enviar link de pago";
  }
  if (text.trim() === "cancelar_link_pago") return "Cancelar link de pago";
  if (text.startsWith("cliente:")) return "Cliente seleccionado";
  if (text.startsWith("configurar_courier:")) return "Configurar courier";
  if (text.startsWith("abrir_ajustes:")) return "Abrir ajustes";
  if (text.startsWith("confirm_whatsapp:")) return "Confirmar WhatsApp";
  return text;
}

export async function persistUserInput(opts: {
  businessId: string;
  actorUserId: string;
  role: "owner" | "employee";
  clientMessageId: string;
  text: string;
}): Promise<void> {
  const humanized = humanizeChipToken(opts.text);
  if (humanized.length > 2000) {
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "USER_INPUT_TRUNCATED",
      a2a_transfer: false,
      message: "User input truncated before persistence",
      businessId: opts.businessId,
      data: { actualLength: humanized.length, truncatedTo: 2000 },
    });
  }
  const safeText = redactPii(humanized.slice(0, 2000));
  const source = opts.role === "owner" ? "owner" : "employee";
  const visibility = inputVisibility(opts.role);

  try {
    await prisma.chatMessage.create({
      data: {
        businessId: opts.businessId,
        clientMessageId: opts.clientMessageId,
        kind: "user",
        source,
        text: safeText,
        visibility,
      },
    });
  } catch (err: unknown) {
    const isUniqueViolation =
      typeof err === "object" &&
      err !== null &&
      (err as { code?: string }).code === "P2002";

    if (isUniqueViolation) {
      // UI client already wrote this row — expected collapse path.
      return;
    }

    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "CHAT_PERSIST_USER_INPUT_FAILED",
      a2a_transfer: false,
      message: "Server-side user-input persist failed — non-blocking",
      businessId: opts.businessId,
      data: { error: err instanceof Error ? err.message : String(err) },
    });
  }
}

/**
 * Persists the assistant reply turn server-side.
 *
 * - Chips are stored on the row when present (schema has `chips Json?`).
 * - P2002 → silent skip.
 * - Any other error → WARNING log. The API response is NOT affected.
 */
export async function persistAssistantReply(opts: {
  businessId: string;
  clientMessageId: string;
  answer: string;
  chips?: unknown;
}): Promise<void> {
  if (opts.answer.length > 8000) {
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "REPLY_TRUNCATED",
      a2a_transfer: false,
      message: "Assistant reply truncated before persistence",
      businessId: opts.businessId,
      data: { actualLength: opts.answer.length, truncatedTo: 8000, paymentIntentId: (opts as { paymentIntentId?: string }).paymentIntentId ?? null },
    });
  }
  const safeText = opts.answer.slice(0, 8000);

  try {
    await prisma.chatMessage.create({
      data: {
        businessId: opts.businessId,
        clientMessageId: opts.clientMessageId,
        kind: "reply",
        source: "assistant",
        text: safeText,
        visibility: "public",
        ...(opts.chips != null ? { chips: opts.chips as Parameters<typeof prisma.chatMessage.create>[0]["data"]["chips"] } : {}),
      },
    });
  } catch (err: unknown) {
    const isUniqueViolation =
      typeof err === "object" &&
      err !== null &&
      (err as { code?: string }).code === "P2002";

    if (isUniqueViolation) {
      return;
    }

    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "CHAT_PERSIST_REPLY_FAILED",
      a2a_transfer: false,
      message: "Server-side assistant-reply persist failed — non-blocking",
      businessId: opts.businessId,
      data: { error: err instanceof Error ? err.message : String(err) },
    });
  }
}
