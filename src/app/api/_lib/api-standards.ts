// API Standards Contract — Velora 2026
// Every route.ts in src/app/api/ must conform to these standards.
// Enforced by scripts/check-api-standards.mjs at CI time.

export interface ApiErrorResponse {
  code: string;
  message: string;
}

export interface ApiSuccessResponse<T = unknown> {
  data?: T;
}

// Required patterns for every mutating API route (POST/PATCH/PUT/DELETE):
// 1. Authentication: resolveActor() or auth() — never unauthenticated writes
// 2. Rate limiting: checkRateLimit(req)
// 3. Structured errors: { code: string, message: string }
// 4. Audit log: recordCriticalWriteEvent() for financial/destructive ops
// 5. Idempotency: beginIdempotentMutation() for money-path operations

export const REQUIRED_MUTATION_PATTERNS = [
  "resolveActor",
  "checkRateLimit",
] as const;

export const FINANCIAL_ROUTES = [
  "sales/create",
  "cash-movements",
  "products",
  "employees",
] as const;

// Routes exempt from auth checks (system-to-system or public by design):
// - scheduled/* — cron jobs authenticated via bearer secret, not user session
// - cron/*      — same pattern as scheduled
// - a2a/*       — agent-to-agent, authenticated via A2A API key
// - auth/*      — NextAuth handler, auth happens inside the handler
// - public/*    — intentionally unauthenticated read endpoints
// - health/*    — liveness probe, no auth required
// - whatsapp/webhook — HMAC-verified by Twilio signature
// - service-worker   — static asset delivery

export const AUTH_EXEMPT_PREFIXES = [
  "scheduled",
  "cron",
  "a2a",
  "auth",
  "public",
  "health",
  "whatsapp",
  "service-worker",
  // mcp: fiscal MCP server — HMAC-gated via X-API-Key + X-Business-Id
  // (same A2A derivation as agent-to-agent calls, no user session required)
  "mcp",
] as const;

// Code size standards — enforced by check:file-size and ESLint
export const CODE_SIZE_STANDARDS = {
  maxFileLines: 300,        // hard limit for existing files
  maxNewFileLines: 250,     // standard for new files
  maxFunctionLines: 30,
  maxClassLines: 100,
  maxInterfaceFields: 30,
  exemptions: ["src/generated/**"], // Prisma machine-generated output
} as const;
