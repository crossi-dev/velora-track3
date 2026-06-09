import { normalizeActionText } from "../shared";
import type { IntentHandler } from "./types";

const EVENT_LABELS: Record<string, string> = {
  rotura: "rotura",
  incidente: "incidente",
  stock_aviso: "aviso de stock",
  queja_cliente: "queja de cliente",
};

// Deterministic answer for report_event: never pass through model `answer`,
// since the event publish happens server-side after the response is built and
// the LLM can hallucinate past-tense beyond what we actually wrote.
export const handleReportEvent: IntentHandler = ({ safeIntent, parsed }) => {
  if (safeIntent !== "report_event") return null;

  const report = parsed.eventReport;
  const eventLabel = report?.eventType ? (EVENT_LABELS[report.eventType] ?? report.eventType) : null;
  const details = normalizeActionText(report?.details) ?? null;

  const confirmAnswer = eventLabel || details
    ? `Anotado${eventLabel ? `: ${eventLabel}` : ""}${details ? ` — ${details}` : ""}. El dueño lo va a ver.`
    : "Anotado. El dueño lo va a ver.";

  return {
    answer: confirmAnswer,
    primaryAction: null,
  };
};
