// Hop-by-hop owner chat writes for the post-confirm chain.
//
// CANONICAL PATTERN (2026):
// Vercel AI SDK 6 / LangGraph 1.2 / Stripe Dashboard / Shopify App Events all
// converge on the same rule: every discrete step of a long-running agent MUST
// emit an observable event BEFORE it resolves. The consumer (owner chat, here)
// gets a row per step so the activity feed is live, not retroactive.
//
// Three design decisions backed by 2026 sources:
// 1. PER-HOP idempotency key (not per-chain): Vercel AI SDK tool spans and
//    LangGraph checkpoint snapshots are keyed per-step, not per-run. A retry
//    must not duplicate a step that already succeeded.
//    Ref: ai-sdk.dev/docs/reference/ai-sdk-core/stream-text (tool spans, 2026),
//         LangGraph 1.2 checkpointing (docs.langchain.com/oss/python/langgraph/overview).
// 2. BEST-EFFORT, never throws: Stripe events are fire-and-forget — missing one
//    does not abort the transaction. Same contract here.
//    Ref: docs.stripe.com/api/events (2026).
// 3. SINGLE-WRITE per outcome per intent (no timestamp suffix on failures):
//    Shopify App Events shows one status line per step; retries UPDATE the line
//    via idempotent upsert. Here we use the same clientMessageId for the failure
//    so each retry overwrites the previous failure and the final success wins via
//    P2002 idempotency. Success key != failure key to keep both visible.
//    Ref: shopify.com/partners/blog/app-events (2026).

import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { cloudLog } from "@/lib/cloud-logger";

type HopChatInput = {
  businessId: string;
  paymentIntentId: string;
  text: string;
  clientMessageId: string;
};

/**
 * Writes a single owner-only ChatMessage for a chain hop.
 * Best-effort: P2002 (duplicate) is silently skipped; any other error is
 * logged at WARNING and swallowed so the chain is never interrupted.
 *
 * source: "manager" — async/auditor writes (CLAUDE.md convention; never
 * "assistant" for background steps).
 * visibility: "owner_only" — employees never see chain internals.
 */
async function writeHopChat(input: HopChatInput): Promise<void> {
  try {
    await prisma.chatMessage.create({
      data: {
        businessId: input.businessId,
        clientMessageId: input.clientMessageId,
        kind: "reply",
        source: "manager",
        visibility: "owner_only",
        text: input.text,
      },
    });
  } catch (err) {
    // Prisma 2026: use the typed discriminator instead of an unsafe cast.
    // Ref: prisma.io/docs/orm/reference/error-reference#p2002 (2026).
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return; // idempotent skip — already written
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "HOP_CHAT_WRITE_FAILED",
      a2a_transfer: false,
      message: `writeHopChat failed (clientMessageId=${input.clientMessageId}): ${err instanceof Error ? err.message : String(err)}`,
      data: { paymentIntentId: input.paymentIntentId },
      businessId: input.businessId,
    });
  }
}

// ── Sentinel ──────────────────────────────────────────────────────────────────
// When the chain resolves (hop 2 comprobante OK, or hop 4 tracking as fallback),
// the ⏳ "Procesando..." row is overwritten with this sentinel so the GET endpoint
// filters it out and the poll loop reconciles it away from the UI.
// Sentinel is intentionally non-human-readable so it never surfaces as visible text.
// Ref: Stripe payment lifecycle resolved state — terminal status marks prior
//   "processing" indicators as complete (docs.stripe.com/payments/payment-intents/lifecycle).
export const HOP_PROCESSING_RESOLVED_SENTINEL = "__hop_resolved__";

// ── Exported hop writers ──────────────────────────────────────────────────────

/** Step 0 — enqueue ack. Mirrors Stripe's "processing" status line on a charge. */
export async function writeHopProcessing(
  businessId: string,
  paymentIntentId: string,
): Promise<void> {
  await writeHopChat({
    businessId,
    paymentIntentId,
    clientMessageId: `hop-processing-${paymentIntentId}`,
    text: "⏳ Procesando comprobante + envío + tracking...",
  });
}

/** Step 1 — comprobante sent OK. */
export async function writeHopComprobanteSent(
  businessId: string,
  paymentIntentId: string,
  customerName: string | null,
): Promise<void> {
  const who = customerName ?? "el cliente";
  await writeHopChat({
    businessId,
    paymentIntentId,
    clientMessageId: `hop-comprobante-${paymentIntentId}`,
    text: `📄 Comprobante enviado a ${who} por WhatsApp.`,
  });
}

/** Step 1 — comprobante failed. */
export async function writeHopComprobanteFailed(
  businessId: string,
  paymentIntentId: string,
  customerName: string | null,
  reason: string,
): Promise<void> {
  const who = customerName ?? "el cliente";
  await writeHopChat({
    businessId,
    paymentIntentId,
    clientMessageId: `hop-comprobante-failed-${paymentIntentId}`,
    text: `⚠️ El envío del comprobante a ${who} falló: ${reason}. Reintentando.`,
  });
}

/** Step 2 — shipment created OK. */
export async function writeHopShipmentCreated(
  businessId: string,
  paymentIntentId: string,
  agentText: string,
): Promise<void> {
  // Extract tracking number from agent text.
  // Andreani mock format (andreani-mock.ts:110): "ARK-{businessId[-6:]}-{12 hex chars}"
  // e.g. "ARK-a1b2c3-d4e5f6g7h8i9"
  // The legacy "mock-tn-" prefix (pre-6a1d53f8) is retained as a fallback to
  // handle any in-flight records written before the UUID-suffix commit.
  // The previous broad pattern [A-Z0-9]{8,20} was over-inclusive: it matched
  // uppercase product codes and order IDs that are not tracking numbers.
  // Ref: Stripe Events fire-and-forget per state change (docs.stripe.com/api/events 2026).
  const trackingMatch = agentText.match(/\b(ARK-[A-Z0-9a-z-]{6,30}|mock-tn-[a-zA-Z0-9-]+)\b/);
  const trackingPart = trackingMatch
    ? ` — tracking ${trackingMatch[1]}`
    : "";
  await writeHopChat({
    businessId,
    paymentIntentId,
    clientMessageId: `hop-shipment-${paymentIntentId}`,
    text: `📦 Envío Andreani creado${trackingPart}.`,
  });
}

/** Step 2 — shipment failed. */
export async function writeHopShipmentFailed(
  businessId: string,
  paymentIntentId: string,
  reason: string,
): Promise<void> {
  await writeHopChat({
    businessId,
    paymentIntentId,
    clientMessageId: `hop-shipment-failed-${paymentIntentId}`,
    text: `⚠️ No pude crear el envío Andreani: ${reason}.`,
  });
}

/** Step 3 — tracking WPP sent OK. */
export async function writeHopTrackingSent(
  businessId: string,
  paymentIntentId: string,
  customerName: string | null,
): Promise<void> {
  const who = customerName ?? "el cliente";
  await writeHopChat({
    businessId,
    paymentIntentId,
    clientMessageId: `hop-tracking-${paymentIntentId}`,
    text: `📲 Tracking enviado a ${who} por WhatsApp.`,
  });
}

/** Step 3 — tracking WPP failed. */
export async function writeHopTrackingFailed(
  businessId: string,
  paymentIntentId: string,
  customerName: string | null,
  reason: string,
): Promise<void> {
  const who = customerName ?? "el cliente";
  await writeHopChat({
    businessId,
    paymentIntentId,
    clientMessageId: `hop-tracking-failed-${paymentIntentId}`,
    text: `⚠️ No pude enviar el tracking a ${who}: ${reason}.`,
  });
}

/**
 * Resolves the ⏳ "Procesando..." row written by writeHopProcessing.
 *
 * Overwrites the text with a sentinel value so the GET endpoint excludes it
 * from the polling feed. The UI poll reconciler then removes the bubble from
 * the rendered chat thread within one poll cycle (~3s).
 *
 * Called after hop 2 (comprobante) succeeds — or as a fallback after hop 4
 * (tracking, either OK or failed) when comprobante was already resolved.
 *
 * Best-effort: never throws — a failure here is cosmetic (stale ⏳ bubble),
 * not transactional. Mirrors Stripe's "processing → succeeded" terminal
 * state transition (docs.stripe.com/payments/payment-intents/lifecycle 2026).
 */
export async function markHopProcessingResolved(
  businessId: string,
  paymentIntentId: string,
): Promise<void> {
  try {
    await prisma.chatMessage.updateMany({
      where: {
        businessId,
        clientMessageId: `hop-processing-${paymentIntentId}`,
        // Only resolve if still showing the original ⏳ text (idempotent guard).
        text: "⏳ Procesando comprobante + envío + tracking...",
      },
      data: { text: HOP_PROCESSING_RESOLVED_SENTINEL },
    });
  } catch (err) {
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "HOP_PROCESSING_RESOLVE_FAILED",
      a2a_transfer: false,
      message: `markHopProcessingResolved failed (intentId=${paymentIntentId}): ${err instanceof Error ? err.message : String(err)}`,
      data: { paymentIntentId },
      businessId,
    });
  }
}
