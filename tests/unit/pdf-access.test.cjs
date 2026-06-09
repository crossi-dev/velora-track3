const assert = require("node:assert/strict");
const test = require("node:test");
const { createHmac } = require("node:crypto");

// Configurar el secreto antes de cargar el módulo
const TEST_SECRET = "secreto-de-prueba-velora";
const TEST_BUSINESS_ID = "biz-test-001";
process.env.WHATSAPP_PDF_TOKEN_SECRET = TEST_SECRET;

const {
  buildPdfAccessUrl,
  isValidPdfAccessToken,
} = require("../../src/app/api/_lib/pdf-access.ts");

// Helper: construye un NextRequest falso con los parámetros de búsqueda indicados
function makeFakeRequest(baseUrl, params = {}) {
  const url = new URL(baseUrl);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value));
  }

  return {
    nextUrl: url,
  };
}

// Helper: construye la firma HMAC V2 (resource + id + businessId + expiry)
function computeSignature(resource, id, expiresAt, businessId = TEST_BUSINESS_ID) {
  const raw = createHmac("sha256", TEST_SECRET)
    .update(`v2:${resource}:${id}:${businessId}:${expiresAt}`)
    .digest();

  return raw
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// Helper: construye una URL válida (V2: incluye biz query param)
function buildValidRequestUrl(resource, id, expiresAt, businessId = TEST_BUSINESS_ID) {
  const token = computeSignature(resource, id, expiresAt, businessId);
  const path =
    resource === "invoice"
      ? `/api/invoices/${id}/pdf`
      : `/api/budgets/${id}/pdf`;

  return `https://velora.app${path}?expires=${expiresAt}&biz=${businessId}&token=${token}`;
}

// ─── buildPdfAccessUrl ───────────────────────────────────────────────────────

test("buildPdfAccessUrl genera una URL con token y expiración para una factura", () => {
  const req = makeFakeRequest("https://velora.app/api/invoices/42/pdf");
  process.env.AUTH_URL = "https://velora.app";

  const result = buildPdfAccessUrl({ req, resource: "invoice", id: "42", businessId: TEST_BUSINESS_ID });

  assert.ok(result, "debe devolver un objeto, no null");
  assert.ok(result.url.includes("/api/invoices/42/pdf"), "la URL debe apuntar al PDF de la factura");
  assert.ok(result.url.includes("token="), "la URL debe incluir el parámetro token");
  assert.ok(result.url.includes("expires="), "la URL debe incluir el parámetro expires");
  assert.ok(typeof result.expiresAt === "number", "expiresAt debe ser un número");
  assert.ok(result.expiresAt > Date.now(), "expiresAt debe ser en el futuro");
});

test("buildPdfAccessUrl genera una URL para un presupuesto", () => {
  const req = makeFakeRequest("https://velora.app/api/budgets/99/pdf");
  process.env.AUTH_URL = "https://velora.app";

  const result = buildPdfAccessUrl({ req, resource: "budget", id: "99", businessId: TEST_BUSINESS_ID });

  assert.ok(result, "debe devolver un objeto, no null");
  assert.ok(result.url.includes("/api/budgets/99/pdf"), "la URL debe apuntar al PDF del presupuesto");
});

test("buildPdfAccessUrl respeta el ttlMs personalizado", () => {
  const req = makeFakeRequest("https://velora.app/api/invoices/7/pdf");
  process.env.AUTH_URL = "https://velora.app";

  const before = Date.now();
  const result = buildPdfAccessUrl({ req, resource: "invoice", id: "7", businessId: TEST_BUSINESS_ID, ttlMs: 60_000 });
  const after = Date.now();

  assert.ok(result, "debe devolver un objeto");
  assert.ok(result.expiresAt >= before + 60_000, "expiresAt debe respetar el TTL mínimo indicado");
  assert.ok(result.expiresAt <= after + 60_000, "expiresAt no debe exceder el TTL indicado");
});

test("buildPdfAccessUrl devuelve null cuando no hay secreto configurado", () => {
  const saved = process.env.WHATSAPP_PDF_TOKEN_SECRET;
  const savedAuth = process.env.AUTH_SECRET;
  const savedNextAuth = process.env.NEXTAUTH_SECRET;

  delete process.env.WHATSAPP_PDF_TOKEN_SECRET;
  delete process.env.AUTH_SECRET;
  delete process.env.NEXTAUTH_SECRET;

  const req = makeFakeRequest("https://velora.app/api/invoices/1/pdf");
  const result = buildPdfAccessUrl({ req, resource: "invoice", id: "1", businessId: TEST_BUSINESS_ID });

  assert.equal(result, null, "sin secreto debe devolver null");

  // Restaurar
  process.env.WHATSAPP_PDF_TOKEN_SECRET = saved;
  if (savedAuth) process.env.AUTH_SECRET = savedAuth;
  if (savedNextAuth) process.env.NEXTAUTH_SECRET = savedNextAuth;
});

// ─── isValidPdfAccessToken ───────────────────────────────────────────────────

test("isValidPdfAccessToken acepta un token válido para una factura", () => {
  const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutos en el futuro
  const url = buildValidRequestUrl("invoice", "42", expiresAt);
  const req = makeFakeRequest(url);

  assert.equal(isValidPdfAccessToken(req, "invoice", "42"), true);
});

test("isValidPdfAccessToken acepta un token válido para un presupuesto", () => {
  const expiresAt = Date.now() + 5 * 60 * 1000;
  const url = buildValidRequestUrl("budget", "99", expiresAt);
  const req = makeFakeRequest(url);

  assert.equal(isValidPdfAccessToken(req, "budget", "99"), true);
});

test("isValidPdfAccessToken rechaza un token expirado", () => {
  const expiresAt = Date.now() - 1; // ya expiró
  const url = buildValidRequestUrl("invoice", "42", expiresAt);
  const req = makeFakeRequest(url);

  assert.equal(isValidPdfAccessToken(req, "invoice", "42"), false);
});

test("isValidPdfAccessToken rechaza una firma adulterada", () => {
  const expiresAt = Date.now() + 5 * 60 * 1000;
  const token = computeSignature("invoice", "42", expiresAt);
  const tamperedToken = token.slice(0, -3) + "xxx"; // reemplazar los últimos 3 chars

  const url = `https://velora.app/api/invoices/42/pdf?expires=${expiresAt}&biz=${TEST_BUSINESS_ID}&token=${tamperedToken}`;
  const req = makeFakeRequest(url);

  assert.equal(isValidPdfAccessToken(req, "invoice", "42"), false);
});

test("isValidPdfAccessToken rechaza un token generado para otro invoiceId", () => {
  const expiresAt = Date.now() + 5 * 60 * 1000;
  // Token válido para id "99", pero lo usamos para id "42"
  const url = buildValidRequestUrl("invoice", "99", expiresAt);
  const req = makeFakeRequest(url);

  assert.equal(isValidPdfAccessToken(req, "invoice", "42"), false);
});

test("isValidPdfAccessToken rechaza un token de factura usado para un presupuesto", () => {
  const expiresAt = Date.now() + 5 * 60 * 1000;
  // Token válido para resource "invoice", pero lo validamos como "budget"
  const url = buildValidRequestUrl("invoice", "42", expiresAt);
  const req = makeFakeRequest(url);

  assert.equal(isValidPdfAccessToken(req, "budget", "42"), false);
});

test("isValidPdfAccessToken rechaza un token generado con secreto incorrecto", () => {
  const expiresAt = Date.now() + 5 * 60 * 1000;
  // Generar firma V2 con un secreto diferente al configurado
  const wrongSignature = createHmac("sha256", "secreto-incorrecto")
    .update(`v2:invoice:42:${TEST_BUSINESS_ID}:${expiresAt}`)
    .digest()
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const url = `https://velora.app/api/invoices/42/pdf?expires=${expiresAt}&biz=${TEST_BUSINESS_ID}&token=${wrongSignature}`;
  const req = makeFakeRequest(url);

  assert.equal(isValidPdfAccessToken(req, "invoice", "42"), false);
});

test("isValidPdfAccessToken rechaza cuando falta el parámetro token", () => {
  const expiresAt = Date.now() + 5 * 60 * 1000;
  const url = `https://velora.app/api/invoices/42/pdf?expires=${expiresAt}`;
  const req = makeFakeRequest(url);

  assert.equal(isValidPdfAccessToken(req, "invoice", "42"), false);
});

test("isValidPdfAccessToken rechaza cuando falta el parámetro expires", () => {
  const token = computeSignature("invoice", "42", Date.now() + 60_000);
  const url = `https://velora.app/api/invoices/42/pdf?token=${token}`;
  const req = makeFakeRequest(url);

  assert.equal(isValidPdfAccessToken(req, "invoice", "42"), false);
});

test("isValidPdfAccessToken rechaza cuando el token está vacío", () => {
  const expiresAt = Date.now() + 5 * 60 * 1000;
  const url = `https://velora.app/api/invoices/42/pdf?expires=${expiresAt}&token=`;
  const req = makeFakeRequest(url);

  assert.equal(isValidPdfAccessToken(req, "invoice", "42"), false);
});

test("isValidPdfAccessToken rechaza cuando no hay secreto configurado", () => {
  const saved = process.env.WHATSAPP_PDF_TOKEN_SECRET;
  const savedAuth = process.env.AUTH_SECRET;
  const savedNextAuth = process.env.NEXTAUTH_SECRET;

  delete process.env.WHATSAPP_PDF_TOKEN_SECRET;
  delete process.env.AUTH_SECRET;
  delete process.env.NEXTAUTH_SECRET;

  const expiresAt = Date.now() + 5 * 60 * 1000;
  const token = computeSignature("invoice", "42", expiresAt);
  const url = `https://velora.app/api/invoices/42/pdf?expires=${expiresAt}&token=${token}`;
  const req = makeFakeRequest(url);

  assert.equal(isValidPdfAccessToken(req, "invoice", "42"), false);

  // Restaurar
  process.env.WHATSAPP_PDF_TOKEN_SECRET = saved;
  if (savedAuth) process.env.AUTH_SECRET = savedAuth;
  if (savedNextAuth) process.env.NEXTAUTH_SECRET = savedNextAuth;
});

// ─── Caso límite: token exactamente en el borde de expiración ────────────────

test("isValidPdfAccessToken rechaza un token con expiresAt exactamente 1 ms en el pasado (borde expirado)", () => {
  // La condición de rechazo es Date.now() > expiresAt.
  // Usamos -1 ms para garantizar que el token ya expiró al momento de validar,
  // sin depender de la velocidad del CPU (evita race conditions con Date.now()).
  const expiresAt = Date.now() - 1;
  const url = buildValidRequestUrl("invoice", "42", expiresAt);
  const req = makeFakeRequest(url);

  assert.equal(isValidPdfAccessToken(req, "invoice", "42"), false);
});
