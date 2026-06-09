// OnboardingAgent — slot-filling auto-advance helpers.
//
// After any tool succeeds, the runner calls buildNextSlotPrompt(after) to
// inject the next pending slot's question+chips into the SAME response turn.
// This implements the ack + auto-advance pattern: the user never has to nudge
// the assistant between onboarding steps.
//
// Source (verified HTTP 200 2026-05-29): Dialogflow CX form filling:
//   https://cloud.google.com/dialogflow/cx/docs/concept/page
//   "all queued messages send together after the final prompt is added to the queue"
//
// Split from onboarding-agent.ts to keep that file under the 300-line contract.

import type { ChipsBundle } from "@/app/api/supervisor/_lib/supervisor-chips";
import type { OnboardingCurrentlyDue } from "@/app/api/business-assistant/_lib/onboarding-session-state";
import type { OnboardingAgentOutput } from "./onboarding-agent.contract";
import { T3_CATALOG_CHIPS } from "@/app/api/business-assistant/_lib/onboarding-fast-path.chips";

export interface NextSlotPrompt { question: string; chips: ChipsBundle | null }

/**
 * Returns the question+chips for the NEXT null/false field in currently_due.
 * Slot order matches detectPendingTurn: name → catalog. Returns null once both
 * are filled.
 *
 * Onboarding v3 (2026-06-04): payment + shipping were REMOVED from the chat
 * chain. They are eventually_due integrations collected from the SetupChecklist
 * dashboard card, NOT forced as chat turns. Chaining them here was the root
 * cause of the "todo en el panel, sin apuro" + "¿cómo cobrás?" contradiction.
 * Source: Stripe incremental onboarding (currently_due vs eventually_due) —
 * https://docs.stripe.com/connect/custom/hosted-onboarding
 */
export function buildNextSlotPrompt(after: OnboardingCurrentlyDue): NextSlotPrompt | null {
  if (after.business_name === null) {
    return { question: "¿Cómo se llama tu negocio?", chips: null };
  }
  if (!after.catalog_ready) {
    return {
      question: "¿Cómo querés cargar tu catálogo?",
      chips: T3_CATALOG_CHIPS,
    };
  }
  // Both currently_due slots filled — no next chat prompt. Services live in the card.
  return null;
}

/**
 * Appends the next-step question+chips to an output after a tool fills a slot.
 * When clientAction is set, the client is mid-picker flow — do not chain.
 */
export function applyNextSlotAutoAdvance(
  output: OnboardingAgentOutput,
  after: OnboardingCurrentlyDue,
): OnboardingAgentOutput {
  if (output.clientAction) return output; // client-side picker in flight — don't chain
  const next = buildNextSlotPrompt(after);
  if (!next) return output; // all slots filled — no next step
  return {
    ...output,
    answer: `${output.answer}\n\n${next.question}`,
    chips: next.chips,
  };
}
