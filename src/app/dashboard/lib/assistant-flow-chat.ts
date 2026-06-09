"use client";

export function buildAssistantCancellationMessage(kind: "confirmation" | "stock_draft") {
  if (kind === "stock_draft") {
    return "Done, discarded that stock load.";
  }

  return "Done, no changes applied.";
}
