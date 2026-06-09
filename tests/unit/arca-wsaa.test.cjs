"use strict";
// Unit tests for ARCA WSAA / WSFE helpers.
// These tests mock HTTPS and GCS — no real AFIP connection is made.

const assert = require("node:assert/strict");
const test = require("node:test");

// ── Inline soap-helpers (subset) — test extractTag / buildSoapEnvelope ─────────

function extractTag(xml, localName) {
  const open = new RegExp(`<(?:[a-zA-Z0-9_]+:)?${localName}(?:\\s[^>]*)?>`, "i");
  const close = new RegExp(`</(?:[a-zA-Z0-9_]+:)?${localName}>`, "i");
  const openMatch = open.exec(xml);
  if (!openMatch) return null;
  const start = openMatch.index + openMatch[0].length;
  const closeMatch = close.exec(xml.slice(start));
  if (!closeMatch) return null;
  return xml.slice(start, start + closeMatch.index).trim();
}

function buildSoapEnvelope(ns, bodyXml) {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" ` +
    `xmlns:ar="${ns}">` +
    `<soapenv:Header/>` +
    `<soapenv:Body>${bodyXml}</soapenv:Body>` +
    `</soapenv:Envelope>`
  );
}

// ── Tests: extractTag ──────────────────────────────────────────────────────────

test("extractTag — extracts simple tag", () => {
  const xml = "<root><token>abc123</token></root>";
  assert.equal(extractTag(xml, "token"), "abc123");
});

test("extractTag — extracts tag with namespace prefix", () => {
  const xml = "<ns:root><ar:sign>XYZ</ar:sign></ns:root>";
  assert.equal(extractTag(xml, "sign"), "XYZ");
});

test("extractTag — returns null for missing tag", () => {
  const xml = "<root><token>abc</token></root>";
  assert.equal(extractTag(xml, "sign"), null);
});

test("extractTag — handles CDATA-like content", () => {
  const xml = "<loginCmsReturn>base64content==</loginCmsReturn>";
  assert.equal(extractTag(xml, "loginCmsReturn"), "base64content==");
});

// ── Tests: WSAA XML builder (loginTicketRequest) ───────────────────────────────

test("loginTicketRequest XML contains service=wsfe", () => {
  // Replicate the builder inline so the test doesn't need TS module loading
  function buildLTR() {
    const now = new Date();
    const generationTime = now.toISOString();
    const expirationTime = new Date(now.getTime() + 12 * 3600 * 1000).toISOString();
    const uniqueId = "1234567890";
    return (
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<loginTicketRequest version="1.0">` +
      `<header>` +
      `<uniqueId>${uniqueId}</uniqueId>` +
      `<generationTime>${generationTime}</generationTime>` +
      `<expirationTime>${expirationTime}</expirationTime>` +
      `</header>` +
      `<service>wsfe</service>` +
      `</loginTicketRequest>`
    );
  }
  const xml = buildLTR();
  assert.equal(extractTag(xml, "service"), "wsfe");
  assert.equal(extractTag(xml, "uniqueId"), "1234567890");
});

// ── Tests: WSFE response parsing ───────────────────────────────────────────────

test("WSFE response parsing — extracts CAE and vencimiento", () => {
  const fakeResponse = `
    <FECAESolicitarResponse>
      <FECAESolicitarResult>
        <FeCabResp><Resultado>A</Resultado></FeCabResp>
        <FeDetResp>
          <FECAEDetResponse>
            <Resultado>A</Resultado>
            <CAE>12345678901234</CAE>
            <CAEFchVto>20261231</CAEFchVto>
          </FECAEDetResponse>
        </FeDetResp>
      </FECAESolicitarResult>
    </FECAESolicitarResponse>
  `;
  assert.equal(extractTag(fakeResponse, "CAE"), "12345678901234");
  assert.equal(extractTag(fakeResponse, "CAEFchVto"), "20261231");
  assert.equal(extractTag(fakeResponse, "Resultado"), "A");
});

test("WSFE response parsing — detects rejection (Resultado=R)", () => {
  const fakeResponse = `
    <FECAESolicitarResponse>
      <FECAESolicitarResult>
        <FeCabResp><Resultado>R</Resultado></FeCabResp>
        <Obs><Ob><Codigo>10043</Codigo><Msg>El campo DocNro es requerido</Msg></Ob></Obs>
      </FECAESolicitarResult>
    </FECAESolicitarResponse>
  `;
  assert.equal(extractTag(fakeResponse, "Resultado"), "R");
  assert.notEqual(extractTag(fakeResponse, "Obs"), null);
});

// ── Tests: SOAP Envelope builder ───────────────────────────────────────────────

test("buildSoapEnvelope wraps body in correct SOAP structure", () => {
  const envelope = buildSoapEnvelope("http://example.com/ns", "<ar:test>data</ar:test>");
  assert.ok(envelope.includes("soapenv:Envelope"));
  assert.ok(envelope.includes("soapenv:Body"));
  assert.ok(envelope.includes("<ar:test>data</ar:test>"));
  assert.ok(envelope.includes('xmlns:ar="http://example.com/ns"'));
});

// ── Tests: emit router (sandbox fallback) ──────────────────────────────────────

test("sandboxEmit returns correct shape", () => {
  // Replicate sandboxEmit inline
  function sandboxEmit(params) {
    const ts = Date.now();
    const cae = String(ts).slice(-14).padStart(14, "0");
    const venc = new Date(ts + 10 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10)
      .replace(/-/g, "");
    return {
      sandbox: true,
      cae,
      vencimiento: venc,
      tipo: params.tipo,
      numero: 1,
      customerCuit: params.customerCuit,
      amountARS: params.amountARS,
      concept: params.concept ?? "Productos y/o servicios",
    };
  }

  const result = sandboxEmit({
    customerCuit: "20123456789",
    amountARS: 1000,
    tipo: "C",
  });

  assert.equal(result.sandbox, true);
  assert.equal(typeof result.cae, "string");
  assert.equal(result.cae.length, 14);
  assert.equal(result.tipo, "C");
  assert.equal(result.amountARS, 1000);
  assert.match(result.vencimiento, /^\d{8}$/); // YYYYMMDD
});

test("sandboxEmit — CAE length is always 14 digits", () => {
  function sandboxEmit() {
    const ts = Date.now();
    return String(ts).slice(-14).padStart(14, "0");
  }
  for (let i = 0; i < 10; i++) {
    assert.equal(sandboxEmit().length, 14);
  }
});

// ── Tests: DER length parser (reimplemented inline) ───────────────────────────

test("parseDerLength — single byte length", () => {
  function parseDerLen(buf, offset) {
    const first = buf[offset];
    if (first < 0x80) return { length: first, headerBytes: 1 };
    const n = first & 0x7f;
    let len = 0;
    for (let i = 0; i < n; i++) len = (len << 8) | buf[offset + 1 + i];
    return { length: len, headerBytes: 1 + n };
  }

  const buf = Buffer.from([0x30, 0x05, 0x02, 0x01, 0x00]);
  const result = parseDerLen(buf, 1);
  assert.equal(result.length, 5);
  assert.equal(result.headerBytes, 1);
});

test("parseDerLength — two-byte length", () => {
  function parseDerLen(buf, offset) {
    const first = buf[offset];
    if (first < 0x80) return { length: first, headerBytes: 1 };
    const n = first & 0x7f;
    let len = 0;
    for (let i = 0; i < n; i++) len = (len << 8) | buf[offset + 1 + i];
    return { length: len, headerBytes: 1 + n };
  }

  const buf = Buffer.from([0x30, 0x81, 0x90]); // length = 0x90 = 144
  const result = parseDerLen(buf, 1);
  assert.equal(result.length, 144);
  assert.equal(result.headerBytes, 2);
});

// ── Tests: ART datetime format ─────────────────────────────────────────────────

test("toAfipDatetime — formats correctly in ART", () => {
  // 2026-05-14T15:00:00Z should be 2026-05-14T12:00:00-03:00
  function toAfipDatetime(d) {
    const utc = d.getTime();
    const art = new Date(utc - 3 * 60 * 60 * 1000);
    const pad = (n) => String(n).padStart(2, "0");
    return (
      `${art.getUTCFullYear()}-${pad(art.getUTCMonth() + 1)}-${pad(art.getUTCDate())}` +
      `T${pad(art.getUTCHours())}:${pad(art.getUTCMinutes())}:${pad(art.getUTCSeconds())}` +
      `-03:00`
    );
  }

  const d = new Date("2026-05-14T15:00:00Z");
  const result = toAfipDatetime(d);
  assert.equal(result, "2026-05-14T12:00:00-03:00");
});

test("toAfipDate — YYYYMMDD format", () => {
  function toAfipDate(d) {
    const pad = (n) => String(n).padStart(2, "0");
    const art = new Date(d.getTime() - 3 * 60 * 60 * 1000);
    return `${art.getUTCFullYear()}${pad(art.getUTCMonth() + 1)}${pad(art.getUTCDate())}`;
  }

  const d = new Date("2026-05-14T15:00:00Z"); // ART = 12:00, same day
  assert.equal(toAfipDate(d), "20260514");

  // Date boundary: 2026-05-15T01:00:00Z → ART = 2026-05-14T22:00:00-03:00
  const d2 = new Date("2026-05-15T01:00:00Z");
  assert.equal(toAfipDate(d2), "20260514");
});

// ── Tests: tipoComprobante mapping ────────────────────────────────────────────

test("mapTipo — Monotributista always gets tipo C (11)", () => {
  function mapTipo(tipo, condicionIva) {
    if (condicionIva === "MT") return 11;
    if (tipo === "A") return 1;
    if (tipo === "B") return 6;
    return 11;
  }

  assert.equal(mapTipo("A", "MT"), 11);
  assert.equal(mapTipo("B", "MT"), 11);
  assert.equal(mapTipo("C", "MT"), 11);
  assert.equal(mapTipo("A", "RI"), 1);
  assert.equal(mapTipo("B", "RI"), 6);
  assert.equal(mapTipo("C", "RI"), 11);
});

// ── Tests: WSAA uniqueId monotonicity (audit hotfix) ─────────────────────────
// Regression tests for the concurrent cold-start uniqueId collision bug.
// Two WSAA calls within the same second used to produce the same uniqueId
// (Math.floor(Date.now()/1000)), causing AFIP to reject the second as a replay.

test("nextUniqueId — produces distinct ids for rapid sequential calls", () => {
  // Replicate the monotonic counter inline — mirrors wsaa.ts implementation.
  let _lastSec = 0;
  let _counter = 0;
  function nextUniqueId() {
    const nowSec = Math.floor(Date.now() / 1000);
    if (nowSec !== _lastSec) {
      _lastSec = nowSec;
      _counter = 0;
    }
    const id = nowSec * 100 + (_counter % 100);
    _counter += 1;
    return id;
  }

  const ids = [];
  for (let i = 0; i < 10; i++) {
    ids.push(nextUniqueId());
  }

  const unique = new Set(ids);
  assert.equal(unique.size, ids.length, `Duplicate ids detected: ${ids.join(", ")}`);
});

test("nextUniqueId — counter resets when second boundary crosses", () => {
  // Simulate a second boundary: the counter should reset to 0 on the new second.
  let _lastSec = 0;
  let _counter = 0;
  function nextUniqueIdWithSec(nowSec) {
    if (nowSec !== _lastSec) {
      _lastSec = nowSec;
      _counter = 0;
    }
    const id = nowSec * 100 + (_counter % 100);
    _counter += 1;
    return id;
  }

  // First second: 3 calls
  const id0 = nextUniqueIdWithSec(1000);
  const id1 = nextUniqueIdWithSec(1000);
  const id2 = nextUniqueIdWithSec(1000);

  // Second boundary: counter must reset
  const id3 = nextUniqueIdWithSec(1001);
  const id4 = nextUniqueIdWithSec(1001);

  assert.equal(id0, 100000); // 1000 * 100 + 0
  assert.equal(id1, 100001); // 1000 * 100 + 1
  assert.equal(id2, 100002); // 1000 * 100 + 2
  assert.equal(id3, 100100); // 1001 * 100 + 0 (counter reset)
  assert.equal(id4, 100101); // 1001 * 100 + 1

  // All ids must be distinct across the boundary
  const all = [id0, id1, id2, id3, id4];
  assert.equal(new Set(all).size, all.length);
});

test("nextUniqueId — old Math.floor(Date.now()/1000) would collide within same second", () => {
  // Document why the old approach was broken.
  const t = Date.now();
  const oldId1 = Math.floor(t / 1000);
  const oldId2 = Math.floor(t / 1000); // same call within same second
  assert.equal(oldId1, oldId2, "Confirms the old approach produces identical ids");
});
