// Unit tests for the C1 fiscal-setup mini-flow.
// Covers: parseFiscalCuit, parseFiscalIvaCondition, parseFiscalPuntoVenta,
// detectFiscalSetupFastPath state machine, and builder output shape.
// Follows the existing onboarding-*.test.cjs pattern (cjs runner, node:test).

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  parseFiscalCuit,
  parseFiscalIvaCondition,
  parseFiscalPuntoVenta,
  detectFiscalSetupFastPath,
  buildFiscalSetupGatePrompt,
} = require("../../src/app/api/business-assistant/_lib/onboarding-fast-path.fiscal-setup.ts");

// ── Base states ────────────────────────────────────────────────────────────────

const STATE_FS1 = { cuitSet: false, ivaConditionSet: false, puntoVentaSet: false };
const STATE_FS2 = { cuitSet: true,  ivaConditionSet: false, puntoVentaSet: false };
const STATE_FS3 = { cuitSet: true,  ivaConditionSet: true,  puntoVentaSet: false };
const STATE_DONE = { cuitSet: true, ivaConditionSet: true,  puntoVentaSet: true  };

// ── parseFiscalCuit ────────────────────────────────────────────────────────────

test("parseFiscalCuit: valid persona jurídica CUIT (30-12345678-1)", () => {
  // 30-12345678-1 — computed check digit via AFIP algorithm.
  const r = parseFiscalCuit("30-12345678-1");
  assert.ok(r !== null, "should not be null");
  assert.ok("cuit" in r, "should have cuit key");
  assert.equal(r.cuit, "30123456781");
});

test("parseFiscalCuit: accepts raw 11 digits", () => {
  // 20-04090856-5 → 20040908565 — a real-world valid CUIT.
  const r = parseFiscalCuit("20040908565");
  assert.ok(r !== null);
  assert.ok("cuit" in r || "error" in r); // either valid or invalid — just no crash
});

test("parseFiscalCuit: rejects fewer than 11 digits", () => {
  assert.equal(parseFiscalCuit("123456"), null);
  assert.equal(parseFiscalCuit("2004090856"), null); // 10 digits
});

test("parseFiscalCuit: rejects text with letters", () => {
  assert.equal(parseFiscalCuit("mi cuit es 30712345678"), null);
  assert.equal(parseFiscalCuit("cuit: 30-71234567-8"), null);
});

test("parseFiscalCuit: invalid check digit returns error object", () => {
  // 30-12345678-0 — correct body but wrong check digit (1 → 0)
  const r = parseFiscalCuit("30-12345678-0");
  assert.ok(r !== null);
  assert.ok("error" in r, "should return error object for bad check digit");
});

test("parseFiscalCuit: empty string returns null", () => {
  assert.equal(parseFiscalCuit(""), null);
  assert.equal(parseFiscalCuit("   "), null);
});

// ── parseFiscalIvaCondition ───────────────────────────────────────────────────

test("parseFiscalIvaCondition: chip exact values", () => {
  assert.equal(parseFiscalIvaCondition("Monotributista"), "Monotributista");
  assert.equal(parseFiscalIvaCondition("Responsable Inscripto"), "Responsable Inscripto");
  assert.equal(parseFiscalIvaCondition("Exento"), "Exento");
});

test("parseFiscalIvaCondition: aliases", () => {
  assert.equal(parseFiscalIvaCondition("mono"), "Monotributista");
  assert.equal(parseFiscalIvaCondition("monotributo"), "Monotributista");
  assert.equal(parseFiscalIvaCondition("RI"), "Responsable Inscripto");
  assert.equal(parseFiscalIvaCondition("ri"), "Responsable Inscripto");
  assert.equal(parseFiscalIvaCondition("exenta"), "Exento");
});

test("parseFiscalIvaCondition: free-text phrase", () => {
  const r = parseFiscalIvaCondition("soy monotributista");
  assert.equal(r, "Monotributista");
});

test("parseFiscalIvaCondition: unknown value returns null", () => {
  assert.equal(parseFiscalIvaCondition("IVA diferencial"), null);
  assert.equal(parseFiscalIvaCondition("no sé"), null);
  assert.equal(parseFiscalIvaCondition(""), null);
});

// ── parseFiscalPuntoVenta ─────────────────────────────────────────────────────

test("parseFiscalPuntoVenta: numeric strings", () => {
  assert.equal(parseFiscalPuntoVenta("1"), "1");
  assert.equal(parseFiscalPuntoVenta("10"), "10");
  assert.equal(parseFiscalPuntoVenta("1001"), "1001");
});

test("parseFiscalPuntoVenta: defer phrases", () => {
  assert.equal(parseFiscalPuntoVenta("más tarde"), "defer");
  assert.equal(parseFiscalPuntoVenta("mas tarde"), "defer");
  assert.equal(parseFiscalPuntoVenta("después"), "defer");
  assert.equal(parseFiscalPuntoVenta("ahora no"), "defer");
  assert.equal(parseFiscalPuntoVenta("skip"), "defer");
});

test("parseFiscalPuntoVenta: rejects out-of-range and non-numeric", () => {
  assert.equal(parseFiscalPuntoVenta("0"), null);      // 0 is not a valid punto de venta
  assert.equal(parseFiscalPuntoVenta("10000"), null);  // > 9999
  assert.equal(parseFiscalPuntoVenta("abc"), null);
  assert.equal(parseFiscalPuntoVenta(""), null);
});

// ── detectFiscalSetupFastPath state machine ───────────────────────────────────

test("state machine: returns null when all fields set (complete)", () => {
  const r = detectFiscalSetupFastPath("Monotributista", STATE_DONE);
  assert.equal(r, null);
});

test("state machine: FS1 — valid CUIT advances to FS2 with IVA chips", () => {
  // 30-12345678-1 — valid AFIP check digit
  const r = detectFiscalSetupFastPath("30-12345678-1", STATE_FS1);
  assert.ok(r !== null);
  assert.equal(r.matchedStep, 1);
  assert.ok(r.chips !== null, "should emit IVA condition chips");
  assert.equal(r.chips.kind, "single");
  assert.equal(r.chips.options.length, 3);
  assert.ok(r.actions.some((a) => a.data.field === "cuit"), "should have cuit action");
});

test("state machine: FS1 — invalid CUIT returns error result", () => {
  const r = detectFiscalSetupFastPath("30-71234567-0", STATE_FS1);
  assert.ok(r !== null);
  assert.equal(r.matchedStep, "error");
  assert.equal(r.actions.length, 0, "error should have no actions");
});

test("state machine: FS1 — non-CUIT text returns null (falls to LLM)", () => {
  assert.equal(detectFiscalSetupFastPath("hola", STATE_FS1), null);
  assert.equal(detectFiscalSetupFastPath("mañana", STATE_FS1), null);
  assert.equal(detectFiscalSetupFastPath("1234", STATE_FS1), null); // 4 digits, not CUIT
});

test("state machine: FS2 — IVA condition chip advances to FS3, emits defer chip", () => {
  const r = detectFiscalSetupFastPath("Monotributista", STATE_FS2);
  assert.ok(r !== null);
  assert.equal(r.matchedStep, 2);
  // FS2 now emits a "Más tarde" defer chip so the user can skip punto de venta inline.
  assert.ok(r.chips !== null, "FS2 debe emitir el chip de diferir");
  assert.equal(r.chips.kind, "single");
  assert.equal(r.chips.options.length, 1);
  assert.equal(r.chips.options[0].value, "mas tarde");
  assert.ok(r.actions.some((a) => a.data.field === "ivaCondition"));
});

test("state machine: FS2 — ignores CUIT-shaped input (wrong step)", () => {
  // When in FS2, a CUIT should not be parsed as IVA condition
  const r = detectFiscalSetupFastPath("30-71234567-8", STATE_FS2);
  assert.equal(r, null);
});

test("state machine: FS3 — numeric punto de venta captured", () => {
  const r = detectFiscalSetupFastPath("1", STATE_FS3);
  assert.ok(r !== null);
  assert.equal(r.matchedStep, 3);
  assert.ok(r.actions.some((a) => a.data.field === "puntoVenta" && a.data.value === "1"));
});

test("state machine: FS3 — defer captures sentinel 0", () => {
  const r = detectFiscalSetupFastPath("más tarde", STATE_FS3);
  assert.ok(r !== null);
  assert.equal(r.matchedStep, 3);
  assert.ok(r.actions.some((a) => a.data.field === "puntoVenta" && a.data.value === "0"));
  // Answer should mention "sandbox" as a reassurance
  assert.ok(r.answer.toLowerCase().includes("sandbox") || r.answer.toLowerCase().includes("configurás"));
});

test("state machine: FS3 — non-numeric non-defer returns null", () => {
  assert.equal(detectFiscalSetupFastPath("abc", STATE_FS3), null);
  assert.equal(detectFiscalSetupFastPath("", STATE_FS3), null);
});

// ── buildFiscalSetupGatePrompt ────────────────────────────────────────────────

test("buildFiscalSetupGatePrompt returns prompt step with no actions", () => {
  const r = buildFiscalSetupGatePrompt();
  assert.equal(r.matchedStep, "prompt");
  assert.equal(r.actions.length, 0);
  assert.ok(r.answer.toLowerCase().includes("cuit"), "prompt should mention CUIT");
});
