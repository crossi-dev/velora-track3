// Bridge between the legacy `VeloraCommand` shape (matched true/false +
// optional compound) and the new `CommandLayerResult` shape (confidence-
// scored, with explicit ambiguous/no-match kinds).
//
// During the migration the v2 entry point calls the legacy parser and runs
// its result through this adapter. As of commit 3, the adapter extracts
// real signals from the raw text + match data, computes a confidence
// score, and emits "match" / "ambiguous" based on threshold bands.

import type { CommandLayerResult, CommandIntentPayload } from "./types-v2";
import { CONFIDENCE_HIGH, CONFIDENCE_LOW, computeConfidence } from "./types-v2";
import { extractSignals } from "./extract-signals";
import type { VeloraCommand, VeloraSingleCommand } from "./shared";

function adaptSingle(rawText: string, cmd: VeloraSingleCommand): CommandLayerResult {
  const signals = extractSignals(rawText, cmd);
  const confidence = computeConfidence(signals);
  const { intent, data } = cmd;
  const payload = { intent, data } as CommandIntentPayload;

  if (confidence >= CONFIDENCE_HIGH) {
    return {
      kind: "match",
      confidence,
      signals,
      ...payload,
    } as CommandLayerResult & CommandIntentPayload;
  }

  if (confidence >= CONFIDENCE_LOW) {
    // Ambiguous band — AI gets the bestGuess as context to confirm or
    // override. The reason string surfaces in logs and user-facing clarifications.
    const reason = signals.includes("imperative-tail")
      ? "imperative-tail-detected"
      : signals.includes("ambiguous-target")
        ? "target-unresolved"
        : "low-confidence-match";
    return {
      kind: "ambiguous",
      confidence,
      reason,
      signals,
      bestGuess: payload,
    };
  }

  return { kind: "no-match", reason: "below-confidence-floor" };
}

export function adaptLegacyCommand(rawText: string, legacy: VeloraCommand): CommandLayerResult {
  if (!legacy.matched) {
    return { kind: "no-match" };
  }
  if ("compound" in legacy) {
    return {
      kind: "compound",
      commands: legacy.commands.map((c) => adaptSingle(rawText, c)),
    };
  }
  return adaptSingle(rawText, legacy);
}
