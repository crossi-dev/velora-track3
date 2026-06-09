import { createHmac, timingSafeEqual } from "crypto";
import { NextRequest } from "next/server";
import { cloudLog } from "@/lib/cloud-logger";

const PDF_TOKEN_TTL_MS = 15 * 60 * 1000;

type PdfResource = "invoice" | "budget" | "purchase-request";

function getPdfTokenSecret() {
  const secret =
    process.env.WHATSAPP_PDF_TOKEN_SECRET ??
    process.env.AUTH_SECRET ??
    process.env.NEXTAUTH_SECRET ??
    "";
  const trimmed = secret.trim();
  if (!trimmed) {
    cloudLog({ severity: "ERROR", component: "System", action: "PDF_SECRET_MISSING", a2a_transfer: false, message: "No PDF token secret configured — PDF links disabled. Set WHATSAPP_PDF_TOKEN_SECRET or AUTH_SECRET." });
  }
  return trimmed;
}

function base64Url(input: Buffer) {
  return input
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// SEC-02: V2 token includes businessId + purpose for defense-in-depth.
// Even if the HMAC secret leaks, an attacker must know the exact
// businessId + resourceId pairing, and links expire.
function computeSignatureV2(resource: PdfResource, id: string, businessId: string, expiresAt: number, secret: string) {
  return base64Url(
    createHmac("sha256", secret)
      .update(`v2:${resource}:${id}:${businessId}:${expiresAt}`)
      .digest()
  );
}

function getBaseUrl(req: NextRequest) {
  const envBase = process.env.AUTH_URL ?? process.env.NEXTAUTH_URL;
  if (envBase) {
    const withScheme = envBase.startsWith("http") ? envBase : `https://${envBase}`;
    return withScheme.replace(/\/$/, "");
  }

  return req.nextUrl.origin;
}

export function buildPdfAccessUrl(args: {
  req: NextRequest;
  resource: PdfResource;
  id: string;
  businessId: string;
  ttlMs?: number;
}) {
  const secret = getPdfTokenSecret();
  if (!secret) return null;

  const expiresAt = Date.now() + (args.ttlMs ?? PDF_TOKEN_TTL_MS);
  const token = computeSignatureV2(args.resource, args.id, args.businessId, expiresAt, secret);
  const baseUrl = getBaseUrl(args.req);
  const path = args.resource === "invoice"
    ? `/api/invoices/${args.id}/pdf`
    : args.resource === "budget"
      ? `/api/budgets/${args.id}/pdf`
      : `/api/purchase-requests/${args.id}/pdf`;
  const url = `${baseUrl}${path}?expires=${expiresAt}&biz=${args.businessId}&token=${token}`;

  return { url, expiresAt };
}

export type PdfTokenResult =
  | { valid: true; version: "v2"; businessId: string }
  | { valid: false };

export function validatePdfAccessToken(req: NextRequest, resource: PdfResource, id: string): PdfTokenResult {
  const secret = getPdfTokenSecret();
  if (!secret) return { valid: false };

  const token = req.nextUrl.searchParams.get("token")?.trim() ?? "";
  const expiresRaw = req.nextUrl.searchParams.get("expires") ?? "";
  const expiresAt = Number(expiresRaw);
  if (!token || !Number.isFinite(expiresAt)) return { valid: false };
  if (Date.now() > expiresAt) return { valid: false };

  const businessId = req.nextUrl.searchParams.get("biz")?.trim() ?? "";
  if (!businessId) return { valid: false };

  const expectedV2 = computeSignatureV2(resource, id, businessId, expiresAt, secret);
  const expectedBuf = Buffer.from(expectedV2, "utf8");
  const tokenBuf = Buffer.from(token, "utf8");
  if (expectedBuf.length === tokenBuf.length && timingSafeEqual(expectedBuf, tokenBuf)) {
    return { valid: true, version: "v2", businessId };
  }

  return { valid: false };
}

// Backward-compatible wrapper — returns boolean like the old API
export function isValidPdfAccessToken(req: NextRequest, resource: PdfResource, id: string): boolean {
  return validatePdfAccessToken(req, resource, id).valid;
}
