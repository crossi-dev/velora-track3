// MODO webhook helpers — auth, status mapping, and startup guard.
// Split from route.ts to keep it under the 300-line server/api area cap.

import { NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { cloudLog } from "@/lib/cloud-logger";

// ── Startup env-var guard ─────────────────────────────────────────────────────
// Log a WARNING at cold-start when MODO_WEBHOOK_SECRET is absent so ops can
// detect the misconfiguration before any real MODO call fails. Same pattern
// as the Andreani startup check. This IIFE runs once per Cloud Run instance.
void (function checkModoWebhookSecretAtStartup() {
  if (!process.env.MODO_WEBHOOK_SECRET) {
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "MODO_WEBHOOK_SECRET_MISSING_STARTUP",
      a2a_transfer: false,
      message:
        "MODO_WEBHOOK_SECRET not set at cold start — all MODO webhook calls will be rejected (fail-closed). Add MODO_WEBHOOK_SECRET to Cloud Run Secret Manager.",
    });
  }
})();

// ── Bearer auth helper ────────────────────────────────────────────────────────
// Returns true only when the Authorization header matches MODO_WEBHOOK_SECRET.
// Fail-closed: if the env var is absent we REJECT the call (logs CRITICAL).
// Uses timingSafeEqual to prevent timing side-channel attacks.
export function verifyModoBearer(req: NextRequest): { ok: boolean; reason?: string } {
  const secret = (process.env.MODO_WEBHOOK_SECRET ?? "").trim();
  if (!secret) {
    cloudLog({
      severity: "CRITICAL",
      component: "System",
      action: "MODO_WEBHOOK_SECRET_MISSING",
      a2a_transfer: false,
      message: "MODO_WEBHOOK_SECRET not set — rejecting all MODO webhook calls (fail-closed). Add MODO_WEBHOOK_SECRET to Secret Manager.",
    });
    return { ok: false, reason: "secret_not_configured" };
  }

  const authHeader = req.headers.get("authorization") ?? "";
  const provided = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!provided) {
    return { ok: false, reason: "missing_bearer" };
  }

  // Constant-time comparison — mismatched lengths are always rejected.
  const secretBuf = Buffer.from(secret, "utf8");
  const providedBuf = Buffer.from(provided, "utf8");
  if (secretBuf.length !== providedBuf.length) {
    return { ok: false, reason: "token_mismatch" };
  }
  const match = timingSafeEqual(secretBuf, providedBuf);
  return match ? { ok: true } : { ok: false, reason: "token_mismatch" };
}

// ── Status mapping ────────────────────────────────────────────────────────────
// MODO statuses: ACCEPTED, REJECTED, CANCELLED
// Velora estados: "pending" | "confirmed" | "expired" | "cancelled"
export function mapModoStatus(modoStatus: string): { estado: string; approved: boolean } | null {
  switch (modoStatus.toUpperCase()) {
    case "ACCEPTED":  return { estado: "confirmed", approved: true };
    case "REJECTED":  return { estado: "cancelled", approved: false };
    case "CANCELLED": return { estado: "cancelled", approved: false };
    default: return null;
  }
}
