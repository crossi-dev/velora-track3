// src/app/.well-known/oauth-protected-resource/[[...path]]/route.ts
//
// RFC 9728 Protected Resource Metadata endpoint.
// MCP spec 2025-06-18 §"Authorization Server Discovery" REQUIRES this endpoint:
//   "MCP servers MUST implement OAuth 2.0 Protected Resource Metadata (RFC 9728)."
//
// This is a public discovery endpoint — NO authentication required.
// It tells MCP clients (Claude Desktop, Cowork, claude.ai) which Authorization
// Server to use when requesting tokens for Velora's MCP server.
//
// OPTIONAL CATCH-ALL ([[...path]]) — required for path-aware discovery.
// RFC 9728 §3.1: when the resource identifier has a path component, the well-known
// string is inserted BETWEEN the host and the path. So for the resource
// `https://tools.somosvelora.com/api/mcp`, a compliant client (Cowork) fetches
//   GET /.well-known/oauth-protected-resource/api/mcp
// NOT the bare `/.well-known/oauth-protected-resource`. The optional catch-all
// matches both the bare path AND the `/api/mcp`-suffixed path with one handler,
// so discovery succeeds regardless of which form the client constructs.
// (A bare static route returned 404 on the suffixed form and broke Cowork's
//  registration step — observed in prod logs 2026-06-02.)
//
// Response shape (RFC 9728 §3):
// {
//   "resource": "<canonical MCP URI>",
//   "authorization_servers": ["<WorkOS AS metadata URL>"]
// }
//
// The canonical resource URI MUST match the `aud` claim Velora validates in
// Bearer tokens (RFC 8707 audience binding).
//
// Sources: datatracker.ietf.org/doc/html/rfc9728 (§3.1 path insertion)

import { NextResponse } from "next/server";
import { MCP_RESOURCE_URI } from "@/lib/mcp/oauth-verify";

export const dynamic = "force-dynamic";

export function GET(): NextResponse {
  // RFC 9728 §2: `authorization_servers` is a list of ISSUER IDENTIFIERS
  // (RFC 8414), NOT metadata-document URLs. The client appends
  // `/.well-known/oauth-authorization-server` to the issuer itself to discover
  // the AS endpoints. Emitting the full `.well-known` URL here breaks discovery:
  // the client can't resolve the registration_endpoint and falls back to POSTing
  // `/register` at the resource origin (tools.somosvelora.com/register → 404),
  // which is exactly what blocked Cowork (observed in prod logs 2026-06-02).
  //
  // WORKOS_AS_ISSUER is the AuthKit issuer (e.g. https://<domain>.authkit.app).
  //
  // Fail-closed: when unconfigured, return 503 instead of a placeholder issuer.
  // Advertising a fake AS misleads MCP clients into sending auth requests to a
  // non-existent endpoint. 503 is unambiguous — the resource exists but OAuth
  // is not yet provisioned on this instance.
  const asIssuer = process.env.WORKOS_AS_ISSUER;
  if (!asIssuer) {
    return NextResponse.json(
      {
        code: "OAUTH_NOT_CONFIGURED",
        message:
          "OAuth 2.0 authorization server is not configured on this instance.",
      },
      { status: 503 },
    );
  }

  const metadata = {
    resource: MCP_RESOURCE_URI,
    authorization_servers: [asIssuer],
  };

  return NextResponse.json(metadata, {
    headers: {
      // Cache-Control: short TTL (5 min) — metadata rarely changes but we don't
      // want stale AS URLs cached indefinitely in clients. RFC 9728 §3 doesn't
      // mandate a specific value; 300s is a reasonable discovery cache.
      "Cache-Control": "public, max-age=300",
    },
  });
}
