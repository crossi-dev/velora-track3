import { cloudLog } from "@/lib/cloud-logger";

// Real production = Cloud Run prod build (NODE_ENV=production). Local dev / CI
// builds are intentionally lenient — they shouldn't fail the build for missing
// OAuth/AI credentials that only matter for end-users in real production.
function isRealProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

/**
 * Strict startup validation — collects ALL missing critical vars and throws
 * a single error listing them together. Called from src/instrumentation.ts
 * so failures happen at server boot, not on first request.
 */
export function validateEnvVars() {
  const missing: string[] = [];

  const url = process.env.DATABASE_URL;
  if (!url) {
    missing.push("DATABASE_URL");
  } else if (!url.startsWith("postgresql://") && !url.startsWith("postgres://")) {
    throw new Error(
      "[velora] DATABASE_URL must be PostgreSQL in this branch (postgresql://...)."
    );
  }

  if (!process.env.AUTH_SECRET) missing.push("AUTH_SECRET");

  if (isRealProduction()) {
    if (!process.env.GOOGLE_CLIENT_ID) missing.push("GOOGLE_CLIENT_ID");
    if (!process.env.GOOGLE_CLIENT_SECRET) missing.push("GOOGLE_CLIENT_SECRET");
    // Required for Capacitor native Sign-In idToken verification.
    if (!process.env.GOOGLE_WEB_CLIENT_ID) missing.push("GOOGLE_WEB_CLIENT_ID");
    // MP real-QR path — all three required for cobro to work end-to-end.
    // Without these, createMpDynamicQr returns null and the system falls
    // back to placeholder QR with no upstream payment processing.
    if (!process.env.MP_DIRECT_ACCESS_TOKEN) missing.push("MP_DIRECT_ACCESS_TOKEN");
    if (!process.env.MP_USER_ID) missing.push("MP_USER_ID");
    if (!process.env.MP_EXTERNAL_POS_ID) missing.push("MP_EXTERNAL_POS_ID");
    // Required so notification_url is deterministic on every QR PUT — without
    // it createMpDynamicQr aborts and the webhook never fires.
    if (!process.env.VELORA_APP_URL) missing.push("VELORA_APP_URL");
    // Required for multi-seller OAuth token encryption at rest.
    if (!process.env.MP_TOKEN_ENCRYPTION_KEY) missing.push("MP_TOKEN_ENCRYPTION_KEY");
    // Audit iter-holistic HIGH #1 (2026-05-25): without these the route handlers
    // silently fail-closed but a misconfigured Cloud Run revision boots clean.
    // Fatal at startup makes silent-degradation impossible.
    if (!process.env.CRON_SECRET) missing.push("CRON_SECRET");
    if (!process.env.MP_WEBHOOK_SECRET) missing.push("MP_WEBHOOK_SECRET");
    if (!process.env.MODO_WEBHOOK_SECRET) missing.push("MODO_WEBHOOK_SECRET");
    if (!process.env.ANDREANI_WEBHOOK_SECRET) missing.push("ANDREANI_WEBHOOK_SECRET");
    // A2A_SECRET is the seed for per-tenant agent key derivation. Without it
    // every sub-agent A2A call falls back to dev raw-secret mode (loud WARN
    // but accepts) which masks misconfiguration.
    if (!process.env.A2A_SECRET) missing.push("A2A_SECRET");
    // AGENTS_BASE_URL is OPTIONAL — Phase A seam (feat/agents-subdomain-p1).
    // When unset, all A2A agent calls self-route to VELORA_APP_URL (current behavior).
    // Set to https://agents.somosvelora.com to redirect to the separate velora-agents
    // Cloud Run service. No required check — absence = identical to today.

    // RESEND_API_KEY, EMAIL_FROM, TWILIO_SMS_FROM are OPTIONAL — messaging channels.
    // Absence causes fail-closed behaviour in sendEmail / sendSms (WARNING log + error
    // result), NOT a startup failure. Boot must not break when these are unset.
    // Set them in Cloud Run env vars or .env to activate email and SMS sending.

    // WorkOS AuthKit OAuth 2.1 Resource Server vars — ALL OPTIONAL.
    // When unset, the Bearer auth path in /api/mcp returns 401 "OAUTH_NOT_CONFIGURED"
    // (fail-closed). The HMAC path (X-API-Key + X-Business-Id) keeps working regardless.
    // Set these in Cloud Run env vars or .env to enable hosted MCP client auth
    // (Claude Desktop, Cowork, claude.ai).
    //
    //   WORKOS_JWKS_URL        — WorkOS JWKS endpoint for JWT signature verification.
    //                            Format: https://<authkit-domain>/oauth2/jwks
    //                            WorkOS dashboard → API Keys → AuthKit domain.
    //
    //   WORKOS_AS_ISSUER       — WorkOS token issuer (`iss` claim to validate against).
    //                            Format: https://<authkit-domain>
    //
    //   WORKOS_AS_METADATA_URL — WorkOS AS metadata URL (for .well-known/oauth-protected-resource).
    //                            Format: https://<authkit-domain>/.well-known/oauth-authorization-server
    //
    //   MCP_RESOURCE_URI       — Canonical MCP resource URI (the `aud` claim Velora validates).
    //                            Default: https://tools.somosvelora.com/api/mcp
    //                            Override for staging/dev environments.
    //                            MUST be registered as a Resource Indicator in WorkOS dashboard.
  }

  if (missing.length > 0) {
    throw new Error(
      `[velora] Missing required environment variables: ${missing.join(", ")}. ` +
        "The application cannot start without these. " +
        "Set them in your environment (or .env) and restart."
    );
  }
}

/**
 * Legacy per-import validation retained for compatibility with prisma.ts.
 * Non-fatal warnings are printed; fatal checks delegated to validateEnvVars
 * so behavior matches when called at startup.
 */
export function validateEnv() {
  // Build-time escape hatch: `next build` traces module imports and triggers
  // this fn before any env is bound. Real validation runs at server boot via
  // validateEnvVars() in instrumentation.ts. Only honored when explicitly set.
  if (process.env.SKIP_ENV_VALIDATION === "1") return;

  const url = process.env.DATABASE_URL;

  if (!url) {
    throw new Error(
      "[velora] DATABASE_URL is not set. " +
        "Set it to a PostgreSQL URL (postgresql://...)."
    );
  }

  if (!url.startsWith("postgresql://") && !url.startsWith("postgres://")) {
    throw new Error(
      "[velora] DATABASE_URL must be PostgreSQL in this branch (postgresql://...)."
    );
  }

  if (!process.env.AUTH_SECRET) {
    throw new Error(
      "[velora] AUTH_SECRET is not set. " +
        "NextAuth requires this variable for signing JWT tokens. " +
        "Generate one with: npx auth secret"
    );
  }

  if (isRealProduction()) {
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
      throw new Error(
        "[velora] GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required in production. " +
          "Users cannot authenticate without Google OAuth credentials."
      );
    }
  }

  const warnings: string[] = [];

  if (!process.env.GOOGLE_CLIENT_ID) warnings.push("GOOGLE_CLIENT_ID");
  if (!process.env.GOOGLE_CLIENT_SECRET) warnings.push("GOOGLE_CLIENT_SECRET");
  // Twilio is the active WhatsApp transport — all three vars are required by
  // sendViaTwilio: ACCOUNT_SID (auth + endpoint), AUTH_TOKEN (Basic auth),
  // WHATSAPP_FROM (sender number). Guard all three symmetrically so a missing
  // var surfaces at boot rather than at first send.
  // WhatsApp Business API vars (WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID,
  // WHATSAPP_VERIFY_TOKEN, WHATSAPP_APP_SECRET) are intentionally absent:
  // Velora uses the Twilio sandbox, not the WA Business API. Gate those behind
  // USE_WHATSAPP_BUSINESS_API=true if ever needed.
  if (!process.env.TWILIO_ACCOUNT_SID) warnings.push("TWILIO_ACCOUNT_SID");
  if (!process.env.TWILIO_AUTH_TOKEN) warnings.push("TWILIO_AUTH_TOKEN");
  if (!process.env.TWILIO_WHATSAPP_FROM) warnings.push("TWILIO_WHATSAPP_FROM");
  if (warnings.length > 0) {
    cloudLog({ severity: "WARNING", component: "System", action: "ENV_VARS_MISSING", a2a_transfer: false, message: `Missing env vars: ${warnings.join(", ")}. Some features may be unavailable.`, data: { missing: warnings } });
  }
}
