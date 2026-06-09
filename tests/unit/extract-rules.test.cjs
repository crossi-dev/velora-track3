const assert = require("node:assert/strict");
const test = require("node:test");

// Stub env/modules that the file under test transitively imports before loading
process.env.AUTH_SECRET = process.env.AUTH_SECRET || "test-secret-not-for-production";
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://test:test@localhost:5432/test";
process.env.NEXTAUTH_URL = process.env.NEXTAUTH_URL || "http://localhost:3000";
process.env.GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "test-client-id";
process.env.GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "test-client-secret";

const { parseExtractionResponse } = require("../../src/app/api/business/business-rules/_lib/extract-rules.ts");

// ── (a) valid JSON with several rules parses correctly ──────────────────────

test("parseExtractionResponse: valid JSON parses all rules correctly", () => {
  const rules = [
    { kind: "time-based", trigger: "apertura_diaria", message: "Abrí la caja a las 9hs.", cron: "0 9 * * 1-5" },
    { kind: "behavior-based", trigger: "saludo_cliente", message: "Saludá a cada cliente al ingresar.", cron: null },
    { kind: "condition-based", trigger: "stock_bajo_galletitas", message: "Cuando queden menos de 5 galletitas, avisale al dueño.", cron: null },
  ];
  const raw = JSON.stringify({ rules });

  const result = parseExtractionResponse(raw, "STOP");

  assert.equal(result.truncated, false);
  assert.equal(result.rules.length, 3);
  assert.equal(result.rules[0].kind, "time-based");
  assert.equal(result.rules[0].trigger, "apertura_diaria");
  assert.equal(result.rules[0].cron, "0 9 * * 1-5");
  assert.equal(result.rules[1].kind, "behavior-based");
  assert.equal(result.rules[2].kind, "condition-based");
});

// ── (b) finishReason MAX_TOKENS → truncated: true ──────────────────────────

test("parseExtractionResponse: finishReason MAX_TOKENS sets truncated:true", () => {
  const rules = [
    { kind: "behavior-based", trigger: "usar_uniforme", message: "Usá el uniforme completo." },
  ];
  const raw = JSON.stringify({ rules });

  const result = parseExtractionResponse(raw, "MAX_TOKENS");

  assert.equal(result.truncated, true);
  assert.equal(result.rules.length, 1);
  assert.equal(result.rules[0].trigger, "usar_uniforme");
});

// ── (c) malformed JSON → { rules: [], truncated: false } ───────────────────

test("parseExtractionResponse: malformed JSON returns empty result", () => {
  const result = parseExtractionResponse("this is not JSON {{{{", undefined);

  assert.equal(result.truncated, false);
  assert.deepEqual(result.rules, []);
});

// ── (d) valid JSON but wrong shape → empty result ──────────────────────────

test("parseExtractionResponse: valid JSON with wrong shape returns empty result", () => {
  // Missing required fields: trigger and message
  const raw = JSON.stringify({ rules: [{ kind: "time-based" }] });

  const result = parseExtractionResponse(raw, "STOP");

  assert.equal(result.truncated, false);
  assert.deepEqual(result.rules, []);
});

// ── (e) MAX_TOKENS with malformed JSON → truncated:true (FIX 3) ───────────

test("parseExtractionResponse: MAX_TOKENS with malformed JSON returns empty + truncated:true", () => {
  // When Gemini truncates mid-response the JSON is cut and JSON.parse throws.
  // The truncated flag must still propagate so the owner sees the "split file" warning.
  const result = parseExtractionResponse("{broken", "MAX_TOKENS");

  assert.equal(result.truncated, true);
  assert.deepEqual(result.rules, []);
});
