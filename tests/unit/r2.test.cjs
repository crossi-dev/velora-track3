const assert = require("node:assert/strict");
const test = require("node:test");

const { buildPdfR2Key } = require("../../src/lib/r2.ts");

// buildPdfR2Key signature (post 3c871ddc): (type, businessId, id, documentNumber?)
// Key format: pdfs/{type}/{businessId}/{number-or-id}.pdf
// Prefix strip: PRES- / FC- / REC- stripped from documentNumber.
// businessId is required so two tenants with the same invoice/tracking number
// never overwrite each other's objects in the shared bucket.

test("buildPdfR2Key: invoice with document number strips REC- prefix", () => {
  const key = buildPdfR2Key("invoice", "biz-abc", "pi-1", "REC-0001-00000035");
  assert.equal(key, "pdfs/invoice/biz-abc/0001-00000035.pdf");
});

test("buildPdfR2Key: budget with document number strips PRES- prefix", () => {
  const key = buildPdfR2Key("budget", "biz-abc", "pi-2", "PRES-0015");
  assert.equal(key, "pdfs/budget/biz-abc/0015.pdf");
});

test("buildPdfR2Key: no documentNumber falls back to first 8 chars of id", () => {
  const key = buildPdfR2Key("invoice", "biz-abc", "abc12345xyz");
  assert.equal(key, "pdfs/invoice/biz-abc/abc12345.pdf");
});

test("buildPdfR2Key: includes businessId in path (tenant isolation)", () => {
  const key1 = buildPdfR2Key("invoice", "tenant-1", "id1", "REC-0001");
  const key2 = buildPdfR2Key("invoice", "tenant-2", "id1", "REC-0001");
  assert.notEqual(key1, key2, "different tenants must produce different keys");
  assert.ok(key1.includes("tenant-1"), "key must contain businessId");
  assert.ok(key2.includes("tenant-2"), "key must contain businessId");
});
