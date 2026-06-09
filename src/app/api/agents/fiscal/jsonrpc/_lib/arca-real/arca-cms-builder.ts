// CMS / PKCS#7 SignedData builder for AFIP WSAA.
//
// The Web Service de Autenticación y Autorización (WSAA) requires the
// loginTicketRequest XML payload to be wrapped in a CMS detached signature
// (RFC 5652). Node.js has no native CMS support, so we hand-build a minimal
// DER-encoded SignedData envelope.
//
// AFIP's WSAA accepts a simpler-than-spec envelope — it validates the
// signature + cert presence, not every ASN.1 field — so this implementation
// constructs a standards-conformant minimal CMS that the server accepts.
//
// References:
//   - RFC 5652 (CMS) — SignedData envelope format
//   - AFIP WSAA Technical Manual v3.0 §4.4

import { createSign, KeyObject } from "node:crypto";

/**
 * Signs `payload` with the private key and wraps it in a CMS SignedData,
 * returning the DER-encoded blob as a base64 string.
 */
export function buildCms(payload: Buffer, privateKey: KeyObject, certPem: string): string {
  const signer = createSign("SHA256");
  signer.update(payload);
  const signature = signer.sign(privateKey);

  const certBase64 = certPem
    .replace(/-----BEGIN CERTIFICATE-----/, "")
    .replace(/-----END CERTIFICATE-----/, "")
    .replace(/\s/g, "");
  const certDer = Buffer.from(certBase64, "base64");

  const cms = buildMinimalCmsDer(payload, signature, certDer);
  return cms.toString("base64");
}

// ── Minimal DER / ASN.1 helpers ───────────────────────────────────────────────

function derLen(data: Buffer): Buffer {
  if (data.length < 0x80) return Buffer.from([data.length]);
  if (data.length <= 0xff) return Buffer.from([0x81, data.length]);
  if (data.length <= 0xffff) {
    return Buffer.from([0x82, data.length >> 8, data.length & 0xff]);
  }
  return Buffer.from([
    0x83,
    (data.length >> 16) & 0xff,
    (data.length >> 8) & 0xff,
    data.length & 0xff,
  ]);
}

function seq(content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([0x30]), derLen(content), content]);
}

function set(content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([0x31]), derLen(content), content]);
}

function oid(bytes: number[]): Buffer {
  const b = Buffer.from(bytes);
  return Buffer.concat([Buffer.from([0x06]), derLen(b), b]);
}

function integer(n: number): Buffer {
  const b = Buffer.from([n]);
  return Buffer.concat([Buffer.from([0x02, 0x01]), b]);
}

function octetString(data: Buffer): Buffer {
  return Buffer.concat([Buffer.from([0x04]), derLen(data), data]);
}

function contextImplicit(tag: number, content: Buffer): Buffer {
  const t = 0xa0 | tag;
  return Buffer.concat([Buffer.from([t]), derLen(content), content]);
}

const OID_SHA256 = [0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01];
const OID_RSA_ENCRYPTION = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01];
const OID_SIGNED_DATA = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x02];
const OID_DATA = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x01];

/**
 * Extracts IssuerName + SerialNumber from a DER-encoded X.509 certificate.
 */
function extractIssuerAndSerial(certDer: Buffer): {
  issuerDer: Buffer;
  serialDer: Buffer;
} {
  let pos = 0;
  if (certDer[pos] !== 0x30) throw new Error("[wsaa] Invalid cert DER: expected SEQUENCE");
  pos++;
  const outerLen = parseDerLen(certDer, pos);
  pos += outerLen.headerBytes;

  if (certDer[pos] !== 0x30) throw new Error("[wsaa] Invalid cert DER: expected tbsCert SEQUENCE");
  pos++;
  const tbsLen = parseDerLen(certDer, pos);
  pos += tbsLen.headerBytes;
  const tbsStart = pos;
  const tbsEnd = tbsStart + tbsLen.length;
  const tbs = certDer.slice(tbsStart, tbsEnd);

  let tbsPos = 0;
  if (tbs[tbsPos] === 0xa0) {
    tbsPos++;
    const vLen = parseDerLen(tbs, tbsPos);
    tbsPos += vLen.headerBytes + vLen.length;
  }

  if (tbs[tbsPos] !== 0x02) throw new Error("[wsaa] Expected serialNumber INTEGER");
  const serialTagPos = tbsPos;
  tbsPos++;
  const serialLen = parseDerLen(tbs, tbsPos);
  const serialDer = tbs.slice(serialTagPos, tbsPos + serialLen.headerBytes + serialLen.length);
  tbsPos += serialLen.headerBytes + serialLen.length;

  if (tbs[tbsPos] !== 0x30) throw new Error("[wsaa] Expected signature AlgId SEQUENCE");
  tbsPos++;
  const algLen = parseDerLen(tbs, tbsPos);
  tbsPos += algLen.headerBytes + algLen.length;

  if (tbs[tbsPos] !== 0x30) throw new Error("[wsaa] Expected issuer Name SEQUENCE");
  const issuerTagPos = tbsPos;
  tbsPos++;
  const issuerLen = parseDerLen(tbs, tbsPos);
  const issuerDer = tbs.slice(
    issuerTagPos,
    tbsPos + issuerLen.headerBytes + issuerLen.length,
  );

  return { issuerDer, serialDer };
}

function parseDerLen(buf: Buffer, offset: number): { length: number; headerBytes: number } {
  const first = buf[offset];
  if (first < 0x80) return { length: first, headerBytes: 1 };
  const n = first & 0x7f;
  let len = 0;
  for (let i = 0; i < n; i++) len = (len << 8) | buf[offset + 1 + i];
  return { length: len, headerBytes: 1 + n };
}

/**
 * Builds a minimal CMS SignedData DER blob for AFIP WSAA.
 */
function buildMinimalCmsDer(
  payload: Buffer,
  signature: Buffer,
  certDer: Buffer,
): Buffer {
  const { issuerDer, serialDer } = extractIssuerAndSerial(certDer);

  const sha256AlgId = seq(
    Buffer.concat([oid(OID_SHA256), Buffer.from([0x05, 0x00])]),
  );

  const encapContentInfo = seq(oid(OID_DATA));

  const issuerAndSerial = seq(Buffer.concat([issuerDer, serialDer]));
  const signerIdentifier = issuerAndSerial;

  const rsaAlgId = seq(
    Buffer.concat([oid(OID_RSA_ENCRYPTION), Buffer.from([0x05, 0x00])]),
  );

  const signerInfo = seq(
    Buffer.concat([
      integer(1),
      signerIdentifier,
      sha256AlgId,
      rsaAlgId,
      octetString(signature),
    ]),
  );

  const signedData = seq(
    Buffer.concat([
      integer(1),
      set(sha256AlgId),
      encapContentInfo,
      contextImplicit(0, certDer),
      set(signerInfo),
    ]),
  );

  const contentInfo = seq(
    Buffer.concat([
      oid(OID_SIGNED_DATA),
      contextImplicit(0, signedData),
    ]),
  );

  return contentInfo;
}
