// SOAP helper — raw HTTPS POST + minimal XML builder.
//
// AFIP uses old-school SOAP 1.1. We avoid any SOAP library and build the
// envelope as a template string. The response is plain XML text; we extract
// values with targeted regex/indexOf slices (no full XML parser needed for
// the narrow fields we care about).

import { request as httpsRequest } from "node:https";
import { URL } from "node:url";

const SOAP_TIMEOUT_MS = 15_000; // 15 s — AFIP endpoints can be slow

// ── HTTP transport ────────────────────────────────────────────────────────────

/**
 * Sends a raw SOAP 1.1 request and returns the raw XML response body.
 * Throws on HTTP error or network failure.
 */
export async function soapPost(
  endpoint: string,
  soapAction: string,
  body: string,
): Promise<string> {
  const url = new URL(endpoint);
  const bodyBuf = Buffer.from(body, "utf-8");

  return new Promise<string>((resolve, reject) => {
    const req = httpsRequest(
      {
        hostname: url.hostname,
        port: url.port ? parseInt(url.port, 10) : 443,
        path: url.pathname + url.search,
        method: "POST",
        timeout: SOAP_TIMEOUT_MS,
        headers: {
          "Content-Type": "text/xml; charset=utf-8",
          "SOAPAction": `"${soapAction}"`,
          "Content-Length": bodyBuf.byteLength,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const xml = Buffer.concat(chunks).toString("utf-8");
          if ((res.statusCode ?? 0) >= 400) {
            reject(
              new Error(
                `[soap] HTTP ${res.statusCode} from ${endpoint}: ${xml.slice(0, 300)}`,
              ),
            );
          } else {
            resolve(xml);
          }
        });
      },
    );
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`[soap] Timeout after ${SOAP_TIMEOUT_MS}ms calling ${endpoint}`));
    });
    req.on("error", reject);
    req.write(bodyBuf);
    req.end();
  });
}

// ── XML extraction helpers ────────────────────────────────────────────────────

/**
 * Extracts the text content of the first occurrence of <tag>…</tag>.
 * Handles namespace prefixes (e.g. <ar:token>).
 * Returns null when the tag is absent.
 */
export function extractTag(xml: string, localName: string): string | null {
  // Match <ns:localName> or <localName> with optional attributes
  const open = new RegExp(`<(?:[a-zA-Z0-9_]+:)?${localName}(?:\\s[^>]*)?>`, "i");
  const close = new RegExp(`</(?:[a-zA-Z0-9_]+:)?${localName}>`, "i");
  const openMatch = open.exec(xml);
  if (!openMatch) return null;
  const start = openMatch.index + openMatch[0].length;
  const closeMatch = close.exec(xml.slice(start));
  if (!closeMatch) return null;
  return xml.slice(start, start + closeMatch.index).trim();
}

/**
 * Extracts the value of an XML attribute from an opening tag.
 * e.g. extractAttr('<Obs Codigo="31" Msg="..."/>', 'Msg') → '...'
 */
export function extractAttr(tag: string, attrName: string): string | null {
  const re = new RegExp(`${attrName}="([^"]*)"`, "i");
  const m = re.exec(tag);
  return m ? m[1] : null;
}

/**
 * Builds a SOAP 1.1 envelope around the given body XML.
 */
export function buildSoapEnvelope(
  namespaceUri: string,
  bodyXml: string,
): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" ` +
    `xmlns:ar="${namespaceUri}">` +
    `<soapenv:Header/>` +
    `<soapenv:Body>${bodyXml}</soapenv:Body>` +
    `</soapenv:Envelope>`
  );
}
