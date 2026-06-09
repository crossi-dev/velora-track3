/**
 * Central registry for Gemini model IDs.
 *
 * Every model reference in Velora must go through this file.
 * To change a model: update the env var in Cloud Run — no rebuild needed.
 *
 * Env var naming convention: GEMINI_<ROLE>_MODEL
 * Location env vars live in gemini-client.ts / gemini-config.ts (unchanged).
 *
 * Model IDs (as of 2026-05-20, verified on Vertex AI):
 *   gemini-3.5-flash       — Flash GA, available in southamerica-east1
 *   gemini-3.1-pro-preview — Pro preview, us-south1 only (Pro GA not yet available)
 *   gemini-2.5-flash-lite  — Flash-Lite GA, us-central1 (NOT in southamerica-east1 — 404s confirmed 2026-05-29)
 */

export const GeminiModels = {
  /**
   * Owner Supervisor — Gemini Pro tier.
   * Deep reasoning, multi-step planning, complex orchestration.
   * Runs in us-south1 (Pro not available in southamerica-east1).
   * Override: GEMINI_SUPERVISOR_MODEL env var.
   */
  SUPERVISOR: process.env.GEMINI_SUPERVISOR_MODEL ?? "gemini-3.1-pro-preview",

  /**
   * Employee Companion — Gemini Flash tier.
   * Fast agentic turns, structured JSON output, thinkingBudget=0.
   * Also used for onboarding polish.
   * Override: GEMINI_MODEL env var (legacy name kept for backward compat).
   */
  COMPANION: process.env.GEMINI_MODEL ?? "gemini-3.5-flash",

  /**
   * Sub-agent runners (Payments, Fiscal, Logística).
   * Flash tier — same performance profile as Companion.
   * Override: GEMINI_SUB_AGENT_MODEL env var (falls back to GEMINI_MODEL).
   */
  SUB_AGENT: process.env.GEMINI_SUB_AGENT_MODEL ?? process.env.GEMINI_MODEL ?? "gemini-3.5-flash",

  /**
   * Rule classifier — lightweight 3-class enum extraction.
   * Flash-Lite: cheaper + faster for deterministic classification tasks.
   * Override: GEMINI_CLASSIFY_MODEL env var.
   */
  CLASSIFY: process.env.GEMINI_CLASSIFY_MODEL ?? "gemini-2.5-flash-lite",

  /**
   * Business rules extractor from PDF/DOCX documents.
   * COST-N-2: Flash default — structured extraction (time patterns, condition triggers)
   * performs comparably to Pro at 90% lower cost per Google I/O 2026 benchmarks.
   * Use GEMINI_RULE_EXTRACT_MODEL=gemini-3.1-pro-preview if complex multi-page rules degrade.
   * Override: GEMINI_RULE_EXTRACT_MODEL env var.
   */
  RULE_EXTRACT: process.env.GEMINI_RULE_EXTRACT_MODEL ?? "gemini-3.5-flash",

  /**
   * Image/OCR product extraction from notebook/label photos.
   * COST-N-2: Flash Vision default — adequate for clean product labels and prices.
   * Use GEMINI_IMAGE_EXTRACT_MODEL=gemini-3.1-pro-preview for handwriting-heavy cases.
   * Override: GEMINI_IMAGE_EXTRACT_MODEL env var.
   */
  IMAGE_EXTRACT: process.env.GEMINI_IMAGE_EXTRACT_MODEL ?? "gemini-3.5-flash",

  /**
   * Shipping NER — structured extraction of customerName/address/postalCode/city.
   * Flash-Lite: fastest + cheapest tier, ideal for deterministic structured extraction
   * with a fixed 4-field schema and max 150 output tokens.
   * Must run in us-central1 (Flash-Lite is NOT available in southamerica-east1 — 404s).
   * Location: NER_LOCATION env var (default us-central1). See extract-shipping-entities.ts.
   * Source: https://ai.google.dev/gemini-api/docs/models — "fastest and most budget-friendly"
   * Override: GEMINI_NER_MODEL env var.
   */
  NER: process.env.GEMINI_NER_MODEL ?? "gemini-2.5-flash-lite",
} as const satisfies Record<string, string>;

export type GeminiModelKey = keyof typeof GeminiModels;
