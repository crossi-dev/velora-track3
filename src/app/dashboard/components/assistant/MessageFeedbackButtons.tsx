"use client";

import { useState } from "react";
import { useT } from "../../lib/DashboardLangContext";

interface Props {
  messageId: string;
  userInput?: string;
  assistantAnswer: string;
}

export function MessageFeedbackButtons({ messageId, userInput, assistantAnswer }: Props) {
  const t = useT();
  const [given, setGiven] = useState<"up" | "down" | null>(null);

  async function submit(feedback: "up" | "down") {
    if (given !== null) return;
    setGiven(feedback);
    try {
      await fetch("/api/chat-feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientMessageId: messageId.replace(/^msg:/, ""),
          feedback,
          userInput,
          assistantAnswer: assistantAnswer.slice(0, 500),
        }),
      });
    } catch {
      // non-critical, silent
    }
  }

  return (
    <div
      style={{
        display: "flex",
        gap: "2px",
        marginTop: "2px",
        paddingLeft: "2px",
      }}
    >
      {(["up", "down"] as const).map((kind) => (
        <button
          key={kind}
          type="button"
          onClick={() => submit(kind)}
          aria-label={kind === "up" ? t("Correct", "Correcto") : t("Incorrect", "Incorrecto")}
          disabled={given !== null}
          style={{
            background: "none",
            border: "none",
            cursor: given !== null ? "default" : "pointer",
            fontSize: "0.875rem",
            lineHeight: 1,
            padding: "10px 11px",
            minWidth: "44px",
            minHeight: "44px",
            borderRadius: "4px",
            opacity: given === null ? 0.4 : given === kind ? 1 : 0.15,
            transition: "opacity 150ms",
            backgroundColor: given === kind ? "var(--brand-soft)" : "transparent",
          }}
        >
          {kind === "up" ? "👍" : "👎"}
        </button>
      ))}
    </div>
  );
}
