// Error handler centralizado del business-assistant route. Distingue 3
// clases de error y mapea a HTTP status + mensaje al usuario:
//   - timeout (AbortError, TimeoutError, "timeout") → 504
//   - upstream 5xx (status code 503/529 or "service unavailable" header text) → 503
//   - unhandled → 500
//
// Classification strategy (2026 best practice — MDN / RFC 7807):
//   1. If the error has a numeric `.status` or `.statusCode` field, use that.
//   2. Else if the message begins with a 3-digit HTTP status code, parse that prefix.
//   3. Otherwise default to UNKNOWN_UPSTREAM — never substring-match arbitrary text
//      for status codes (false-positive on product names, port numbers, Postgres errors).
//   Ref: https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status
//
// Vive separado del route.ts para mantener el handler principal por
// below the 400-line file size limit (project conventions).

import { NextResponse } from "next/server";
import { logRouteError } from "@/app/api/_lib/route-helpers";
import { cloudLog } from "@/lib/cloud-logger";

export function handleAssistantRouteError(error: unknown, businessId?: string): NextResponse {
  logRouteError("business-assistant", error);
  const detail = error instanceof Error ? error.message : "";
  const errName = error instanceof Error ? error.name : "";

  const isTimeout =
    errName === "AbortError" ||
    errName === "TimeoutError" ||
    detail.toLowerCase().includes("timeout");
  if (isTimeout) {
    cloudLog({ severity: "WARNING", component: "System", action: "ROUTE_TIMEOUT", a2a_transfer: false, message: "Business assistant request timed out", businessId, data: { name: errName, message: detail } });
    const msg = "Está tardando más de lo normal. Intentá de nuevo en un momento.";
    return NextResponse.json(
      { code: "TIMEOUT", message: msg },
      { status: 504 },
    );
  }

  // Resolve a numeric HTTP status from the error object, if available.
  // Priority: .status (Response / GoogleGenAI error shape) → .statusCode (Node/web-push shape)
  // → leading 3-digit prefix in message (Gemini SDK embeds "503 Service Unavailable" at start).
  // Never substring-match arbitrary positions in .message — false-positive on port numbers,
  // product names like "Plan 503", or Postgres error codes.
  const errObj = error as Record<string, unknown>;
  const structuredStatus =
    typeof errObj.status === "number" ? errObj.status :
    typeof errObj.statusCode === "number" ? errObj.statusCode :
    null;
  const leadingStatusMatch = structuredStatus === null
    ? /^([1-5]\d{2})\b/.exec(detail)
    : null;
  const httpStatus: number | null =
    structuredStatus ?? (leadingStatusMatch ? parseInt(leadingStatusMatch[1], 10) : null);

  const isUpstream5xx =
    httpStatus === 503 ||
    httpStatus === 529 ||
    detail.toLowerCase().includes("service unavailable");

  if (isUpstream5xx) {
    cloudLog({ severity: "ERROR", component: "System", action: "ROUTE_UPSTREAM_5XX", a2a_transfer: false, message: "Upstream LLM service unavailable", businessId, data: { httpStatus, message: detail } });
    const msg = "Servicio temporalmente no disponible. Reintenta en unos segundos.";
    return NextResponse.json(
      { code: "SERVICE_UNAVAILABLE", message: msg },
      { status: 503 },
    );
  }

  // httpStatus present but not a known retryable code → classify as unhandled.
  // httpStatus absent → ERROR_CLASSIFICATION_FALLBACK_UNKNOWN fires so ops can
  // identify error shapes that need a structured .status field upstream.
  const action = httpStatus === null ? "ERROR_CLASSIFICATION_FALLBACK_UNKNOWN" : "ROUTE_UNHANDLED_ERROR";
  cloudLog({ severity: "ERROR", component: "System", action, a2a_transfer: false, message: "Unhandled business assistant error", businessId, data: { name: errName, httpStatus, message: detail } });
  const msg = "No se pudo procesar la solicitud. Intentá de nuevo.";
  return NextResponse.json(
    { code: "INTERNAL", message: msg },
    { status: 500 },
  );
}
