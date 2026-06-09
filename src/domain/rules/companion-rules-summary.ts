// Plain-English rules block for injection into the companion system prompt.

import { OWNER_ONLY_INTENTS } from "../role-contract";

export function buildCompanionRulesSummary(): string {
  const blocked = [...OWNER_ONLY_INTENTS].join(", ");
  return [
    "ROLE CONSTRAINTS (employee — companion):",
    `- Blocked intents (owner only): ${blocked}.`,
    "- If employee attempts a blocked intent, respond with a warm refusal — do not execute.",
    "",
    "BUSINESS RULES (hard blocks — system enforces, do not override):",
    "- Sale total must be > 0.",
    "- Cannot sell more units than available stock.",
    "- Product name and price are required.",
    "- Cash movement amount must be > 0 and description is required.",
    "- Sale must have at least one item with quantity as a positive whole number.",
    "- Invoice must be linked to a sale and have a number.",
    "",
    "REMINDERS (advisory — mention to the team, never block):",
    "- Behavior reminders (greet, smile, uniform) and time reminders are coaching cues, not gates.",
    "- The server only blocks operations that violate verifiable RULES (condition-based + DelegationPolicy).",
  ].join("\n");
}
