/**
 * Pure utility functions for the assistant chat module.
 * No React hooks — only stateless helpers for message formatting,
 * response parsing, and error mapping.
 */

import type { AssistantAction, AssistantConfirmationRequest, ChipsBundle, ParsedSale, AgentActivity, WidgetDescriptor } from "../types";
import { parseChipsBundle } from "./chips-parse";
import { widgetSchema } from "../widget-schema";

// ── Response parsing ────────────────────────────────────────────────

export interface ParsedAssistantResponse {
  /**
   * Flat list of actions to execute. Server emits primary action (if any) at
   * index 0, then any compound extras detected in the same user message
   * (e.g. "carga 15 bananas y precio cambia a 500" → stock_load + edit_product).
   * Each action is dispatched independently with its own try/catch and feedback.
   */
  actions: AssistantAction[];
  confirmationRequest: AssistantConfirmationRequest | undefined;
  assistantAnswer: string | null;
  questionContext: string | null;
  questionInputHint: string | null;
  /** The raw `answer` field before sanitisation. */
  rawAnswer: string | null;
  /**
   * Server-pre-resolved sale draft. When present and all items have unitPrice,
   * clients can open the sale confirmation directly and skip the
   * /api/parse-sale roundtrip.
   */
  saleDraft?: ParsedSale | null;
  /**
   * When the server detects ambiguous customer during sale extraction,
   * it returns candidates so the client can show a picker.
   */
  customerSelect?: {
    query: string;
    candidates: Array<{ id: string; name: string }>;
  } | null;
  /**
   * Optional tappable quick-reply chips emitted by supervisor.
   * Renders as buttons under the assistant message.
   */
  chips?: ChipsBundle | null;
  /**
   * Generative-UI widget descriptor emitted by the backend (slice 2) for
   * read-only data intents (e.g. sales_summary, stock_table). Rendered below
   * the assistant bubble via WidgetRenderer. Validated with the shared Zod
   * schema (widget-schema.ts) so a malformed descriptor never crashes the chat.
   */
  widget?: WidgetDescriptor | null;
  /**
   * Agent activity bubbles — which A2A sub-agents participated in this turn.
   * Emitted by the backend in the `agentActivity` field of the chat response.
   */
  agentActivity?: AgentActivity[] | null;
  /**
   * Server-canonical clientMessageId for the assistant reply row.
   * Format: `{idempotencyKey}-reply` (deriveReplyClientMessageId convention).
   * When present, the client must use this ID for its durable reply entry so
   * the /api/chat-history upsert collapses the client + server writes into one
   * DB row instead of creating a duplicate.
   */
  replyClientMessageId?: string | null;
}

/**
 * Extracts and sanitises fields from the raw JSON returned by
 * `/api/business-assistant`.
 */
export function parseAssistantResponse(
  data: Record<string, unknown>
): ParsedAssistantResponse {
  const rawActions = Array.isArray(data.actions) ? (data.actions as AssistantAction[]) : null;
  const actions: AssistantAction[] = rawActions
    ? rawActions.filter((a): a is AssistantAction => !!a && typeof a === "object" && typeof (a as { type?: unknown }).type === "string")
    : [];
  const confirmationRequest = data.confirmationRequest as
    | AssistantConfirmationRequest
    | undefined;

  const rawAnswer =
    typeof data.answer === "string" ? data.answer : null;

  // Strip any leaked JSON from the assistant answer (Gemini sometimes
  // includes the raw JSON object after the conversational text).
  const assistantAnswer = rawAnswer
    ? rawAnswer
        .replace(/\s*```json[\s\S]*```\s*/gi, "")
        .replace(/\s*\{[\s\S]*"intent"[\s\S]*\}\s*$/g, "")
        .trim() || rawAnswer
    : null;

  const questionContext =
    typeof data.questionContext === "string" ? data.questionContext : null;
  const questionInputHint =
    typeof data.inputHint === "string" ? data.inputHint : null;

  // Extract pre-resolved sale draft if the server ran the extractor.
  // Convert to ParsedSale shape; null customer id becomes empty string
  // (matching the legacy /api/parse-sale convention). If any item is
  // missing a unit price, we leave saleDraft null so the client falls
  // back to the legacy parse-sale path for price clarification UI.
  const serverSaleDraft = data.saleDraft as
    | {
        customer?: { id?: string | null; name?: string };
        items?: Array<{
          productId?: string;
          productName?: string;
          quantity?: number;
          unitPrice?: number | null;
          subtotal?: number | null;
        }>;
        total?: number;
      }
    | undefined;

  let saleDraft: ParsedSale | null = null;
  if (
    serverSaleDraft &&
    Array.isArray(serverSaleDraft.items) &&
    serverSaleDraft.items.length > 0 &&
    serverSaleDraft.items.every(
      (item) =>
        typeof item.productId === "string" &&
        typeof item.productName === "string" &&
        typeof item.quantity === "number" &&
        typeof item.unitPrice === "number" &&
        item.unitPrice > 0 &&
        typeof item.subtotal === "number"
    )
  ) {
    saleDraft = {
      customer: {
        id: serverSaleDraft.customer?.id ?? "",
        name: serverSaleDraft.customer?.name ?? "Consumidor Final",
      },
      items: serverSaleDraft.items.map((item) => ({
        productId: item.productId as string,
        productName: item.productName as string,
        quantity: item.quantity as number,
        unitPrice: item.unitPrice as number,
        subtotal: item.subtotal as number,
      })),
      total: typeof serverSaleDraft.total === "number" ? serverSaleDraft.total : 0,
    };
  }

  const customerSelectRaw = data.customerSelect as
    | { query?: string; candidates?: Array<{ id?: string; name?: string }> }
    | undefined;
  const customerSelect =
    customerSelectRaw &&
    typeof customerSelectRaw.query === "string" &&
    Array.isArray(customerSelectRaw.candidates)
      ? {
          query: customerSelectRaw.query,
          candidates: customerSelectRaw.candidates.filter(
            (c): c is { id: string; name: string } =>
              !!c && typeof c.id === "string" && typeof c.name === "string"
          ),
        }
      : null;

  const chips = parseChipsBundle(data.chips);

  // Widget descriptor — validated with the shared Zod union. safeParse keeps a
  // malformed/unknown descriptor from crashing the chat (returns null instead).
  const widgetParsed = widgetSchema.safeParse(data.widget);
  const widget: WidgetDescriptor | null =
    widgetParsed.success && widgetParsed.data ? widgetParsed.data : null;

  // Parse agent activity — array of { agentId, agentLabel, action, latencyMs, icon }
  const agentActivity: AgentActivity[] | null = (() => {
    const raw = data.agentActivity;
    if (!Array.isArray(raw)) return null;
    const parsed = raw.filter(
      (item): item is AgentActivity =>
        !!item &&
        typeof item === "object" &&
        typeof (item as Record<string, unknown>).agentId === "string" &&
        typeof (item as Record<string, unknown>).agentLabel === "string" &&
        typeof (item as Record<string, unknown>).action === "string" &&
        typeof (item as Record<string, unknown>).latencyMs === "number" &&
        typeof (item as Record<string, unknown>).icon === "string"
    );
    return parsed.length > 0 ? parsed : null;
  })();

  // C3: extract the server-canonical reply clientMessageId so the client can
  // pin its durable entry to the same ID and enable P2002 dedup collapse.
  const replyClientMessageId =
    typeof data.replyClientMessageId === "string" ? data.replyClientMessageId : null;

  return {
    actions,
    confirmationRequest,
    assistantAnswer,
    questionContext,
    questionInputHint,
    rawAnswer,
    saleDraft,
    customerSelect,
    chips,
    widget,
    agentActivity,
    replyClientMessageId,
  };
}

// ── Error helpers ───────────────────────────────────────────────────

/**
 * Extracts a user-facing error message from an unknown thrown value,
 * falling back to `fallback`.
 */
export function toErrorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

// ── Edit-product reply builder ──────────────────────────────────────

export function buildEditProductReply(
  field: string,
  productName: string,
  value: string,
  t: (en: string, es: string) => string
): string {
  if (field === "price") {
    return t(
      `Price updated: ${productName} → $${value}`,
      `Precio actualizado: ${productName} → $${value}`
    );
  }
  if (field === "costPrice") {
    return t(
      `Cost price updated: ${productName} → $${value}`,
      `Precio de costo actualizado: ${productName} → $${value}`
    );
  }
  if (field === "name") {
    return t(
      `Product updated.\n${value}`,
      `Producto actualizado.\n${value}`
    );
  }
  return t(
    `Product updated.\n${productName}`,
    `Producto actualizado.\n${productName}`
  );
}
