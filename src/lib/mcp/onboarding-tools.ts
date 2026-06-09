// src/lib/mcp/onboarding-tools.ts — Conversational onboarding MCP tools.
//
// Registers 5 tenant-scoped onboarding tools (BYOA — "secret never through chat"):
//   connect_mercadopago — OAuth-redirect (primary) or APP_USR- token fallback.
//   connect_pedidosya   — secure-form link (primary) or apiToken fallback.
//   connect_whatsapp    — Meta Embedded Signup link (primary) + optional phone pre-step.
//   connect_tiendanube  — OAuth-redirect (primary). Handler: _lib/tiendanube-connect-byoa.ts.
//   upload_catalog      — bulk-create up to 50 products.
//
// businessId from server closure only. Handler logic in _lib/onboarding-mutations.ts.
// References:
//   MCP 2025-11-25 third-party auth: https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization
//   MCP annotations: https://modelcontextprotocol.io/specification/2025-06-18/schema

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildMpAuthorizationUrl, getMpConfig } from "@/app/api/integrations/mp/_lib/config";
import { createOAuthState } from "@/app/api/integrations/mp/_lib/oauth-state";
import { connectMercadoPago } from "@/app/api/integrations/mp/connect-token/_lib/mp-connect-core";
import {
  errResponse,
  connectPedidosYaByoaHandler,
  connectWhatsappByoaHandler,
  uploadCatalogHandler,
  UPLOAD_CATALOG_MAX,
} from "./_lib/onboarding-mutations";
import { connectTiendanubeByoaHandler } from "./_lib/tiendanube-connect-byoa";
import { MCP_ACTOR_USER_ID } from "./_lib/catalog-mutations";

// ── Registration ──────────────────────────────────────────────────────────────

/**
 * Registers the 4 conversational onboarding tools on the given MCP server.
 * Called only when a verified businessId is available from the auth gate.
 * businessId comes from the closure — NEVER from tool input (tenant isolation).
 */
export function registerOnboardingTools(
  server: McpServer,
  businessId: string,
): void {

  // ── Tool: connect_mercadopago ──────────────────────────────────────────────
  // AUTH/PAYMENTS — BYOA OAuth-redirect (MCP 2025-11-25 standard).
  // Primary: OAuthState → return auth.mercadopago.com.ar URL → callback stores token.
  // Fallback: optional APP_USR- token supplied directly (demo / self-managed).
  server.registerTool(
    "connect_mercadopago",
    {
      title: "Connect MercadoPago",
      description:
        "Connects MercadoPago for this business using the BYOA OAuth-redirect model " +
        "(MCP 2025-11-25 third-party authorization standard). " +
        "PRIMARY (recommended): call with no accessToken — returns a secure MercadoPago " +
        "authorization URL (auth.mercadopago.com.ar). The owner opens that URL, " +
        "authorizes on the official MercadoPago site, and Velora completes the connection " +
        "server-side via the OAuth callback. No token ever passes through chat. " +
        "FALLBACK (demo / self-managed token): supply an APP_USR- production token " +
        "to validate+encrypt+store it directly (same as the legacy flow). " +
        "accessToken must start with APP_USR- and comes from " +
        "developers.mercadopago.com.ar → Tu aplicación → Credenciales de producción. " +
        "Primary path returns { ok: true, action: 'authorize', authorizationUrl, instructions }. " +
        "Fallback returns { ok: true, mpUserId } on success. " +
        "On failure returns isError:true with a domain error code: " +
        "MP_NOT_CONFIGURED (OAuth env vars missing), " +
        "INVALID_TOKEN (bad/expired token), MP_UNREACHABLE (network), UPSERT_FAILED (DB error). " +
        "This is a credential write — confirm intent with the owner before executing.",
      inputSchema: {
        accessToken: z
          .string()
          .min(20)
          .startsWith("APP_USR-")
          .optional()
          .describe(
            "Optional. MercadoPago Production access token starting with APP_USR-. " +
            "Omit to use the recommended OAuth-redirect flow (returns authorizationUrl). " +
            "Supply only when the owner already has a self-managed token and wants to use " +
            "the direct token-connect fallback.",
          ),
      },
      // destructiveHint: true — may write/replace credential record; validates against external MP API.
      annotations: {
        readOnlyHint: false,
        idempotentHint: true,  // upsert — safe to retry
        destructiveHint: true,
        openWorldHint: true,   // OAuth URL build or MP API validation
      },
    },
    async (args) => {
      const { accessToken } = args;

      // ── Token fallback path (optional APP_USR- token supplied) ──────────────
      if (accessToken !== undefined) {
        const result = await connectMercadoPago({
          businessId,
          actorUserId: MCP_ACTOR_USER_ID,
          accessToken,
        });
        if (!result.ok) return errResponse(result.code, result.message);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ ok: true, mpUserId: result.mpUserId }) }],
        };
      }

      // ── Primary OAuth-redirect path ──────────────────────────────────────────
      // MCP 2025-11-25 third-party authorization: return the authorization URL
      // so the owner authorizes on the official MercadoPago site. Velora's
      // /api/integrations/mp/callback completes the exchange server-side.
      const cfg = getMpConfig();
      if (!cfg.isConfigured) {
        return errResponse(
          "MP_NOT_CONFIGURED",
          "MercadoPago OAuth no está configurado todavía. " +
          "El administrador de Velora necesita configurar MP_CLIENT_ID, MP_CLIENT_SECRET y MP_REDIRECT_URI.",
        );
      }

      try {
        const state = await createOAuthState(businessId);
        const authorizationUrl = buildMpAuthorizationUrl({
          clientId: cfg.clientId,
          redirectUri: cfg.redirectUri,
          state,
        });
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              ok: true,
              action: "authorize",
              authorizationUrl,
              instructions:
                "Abrí este link para conectar tu cuenta de MercadoPago de forma segura. " +
                "Vas a autorizar en el sitio oficial de MercadoPago; " +
                "Velora nunca ve tu contraseña ni tu token.",
            }),
          }],
        };
      } catch {
        return errResponse(
          "UPSERT_FAILED",
          "No se pudo generar el link de autorización. Reintentá en unos segundos.",
        );
      }
    },
  );

  // ── Tool: connect_pedidosya ────────────────────────────────────────────────
  // BYOA secure-form model. Handler: connectPedidosYaByoaHandler (onboarding-mutations.ts).
  server.registerTool(
    "connect_pedidosya",
    {
      title: "Connect PedidosYa",
      description:
        "Connects PedidosYa for this business using the BYOA secure-form model. " +
        "PRIMARY (recommended): call with no apiToken — returns a secure Velora link where " +
        "the owner pastes their PedidosYa API token on a protected web page. " +
        "The token is never sent through chat. " +
        "Returns { ok: true, action: 'connect_form', connectUrl, instructions }. " +
        "FALLBACK (demo / automation): supply apiToken to encrypt+store the token directly. " +
        "The apiToken is AES-256-GCM encrypted at rest; no plaintext is persisted. " +
        "No live API validation is performed — the token is validated on first use. " +
        "Returns { ok: true } on fallback success. " +
        "On failure returns isError:true with a domain error code: " +
        "INVALID_TOKEN (empty/missing), ENCRYPT_FAILED, UPSERT_FAILED.",
      inputSchema: {
        apiToken: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Optional. PedidosYa API token from the PedidosYa partner portal. " +
            "Omit to use the recommended secure-form flow (returns connectUrl). " +
            "Supply only for demo or automation use-cases where the token is already available.",
          ),
      },
      // destructiveHint: true — fallback path writes/replaces encrypted credential record.
      annotations: {
        readOnlyHint: false,
        idempotentHint: true,  // upsert — safe to retry
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    async (args) => connectPedidosYaByoaHandler(businessId, args.apiToken),
  );

  // ── Tool: connect_whatsapp ─────────────────────────────────────────────────
  // BYOA Meta Embedded Signup model. Handler: connectWhatsappByoaHandler (onboarding-mutations.ts).
  server.registerTool(
    "connect_whatsapp",
    {
      title: "Connect WhatsApp",
      description:
        "Connects WhatsApp Business for this business using the BYOA Meta Embedded Signup model. " +
        "PRIMARY (recommended): call with no phone — returns a secure link to the Velora " +
        "Servicios page that launches the official Meta Embedded Signup flow in the owner's browser. " +
        "Credentials (WABA token) are exchanged server-side via the Meta API; " +
        "Velora never sees the owner's Meta password. " +
        "Returns { ok: true, action: 'authorize', connectUrl, instructions }. " +
        "OPTIONAL phone pre-step: supply a phone in E.164 format to also register the " +
        "business WhatsApp phone number (sets Business.whatsappBusinessPhoneE164) as a " +
        "lightweight first step — the response still includes the connectUrl to complete " +
        "the full WABA connection. " +
        "Returns { ok: true, action: 'authorize', connectUrl, instructions, phone } when phone is supplied. " +
        "On failure returns isError:true with code INVALID_PHONE or SAVE_FAILED.",
      inputSchema: {
        phone: z
          .string()
          .min(8)
          .optional()
          .describe(
            "Optional. WhatsApp Business phone in E.164 format (e.g. +5491100000000). " +
            "If supplied, registers the phone number as a lightweight pre-step AND returns " +
            "the Meta signup link to complete the full WABA connection. " +
            "Omit to go straight to the Meta Embedded Signup link without a phone pre-step.",
          ),
      },
      // destructiveHint: true — optional phone path writes/replaces Business.whatsappBusinessPhoneE164.
      annotations: {
        readOnlyHint: false,
        idempotentHint: true,  // upsert — safe to retry
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    async (args) => connectWhatsappByoaHandler(businessId, args.phone),
  );

  // ── Tool: connect_tiendanube ───────────────────────────────────────────────
  // AUTH/INTEGRATIONS — BYOA OAuth-redirect model (MCP 2025-11-25 standard).
  // Handler logic extracted to _lib/tiendanube-connect-byoa.ts (size limit).
  // Credential stored as BusinessChannelCredential (provider "tiendanube"):
  //   { accessToken, storeId } — exact shape loadTiendanubeCredentials reads.
  // Source: tiendanube.github.io/api-documentation/authentication
  server.registerTool(
    "connect_tiendanube",
    {
      title: "Connect Tienda Nube",
      description:
        "Connects Tienda Nube (Nuvemshop) for this business using the BYOA OAuth-redirect model " +
        "(MCP 2025-11-25 third-party authorization standard). " +
        "Call with no arguments — returns a secure Tienda Nube authorization URL. " +
        "The owner opens that URL, authorizes on the official Tienda Nube site, and Velora " +
        "completes the connection server-side via the OAuth callback. " +
        "No token ever passes through chat. " +
        "Returns { ok: true, action: 'authorize', authorizationUrl, instructions }. " +
        "On failure returns isError:true with code: " +
        "TN_NOT_CONFIGURED (env vars missing), UPSERT_FAILED (DB error generating state token). " +
        "This is a credential write — confirm intent with the owner before executing.",
      inputSchema: {},
      annotations: {
        readOnlyHint: false,
        idempotentHint: true,
        destructiveHint: true,
        openWorldHint: true,
      },
    },
    async () => connectTiendanubeByoaHandler(businessId),
  );

  // ── Tool: upload_catalog ──────────────────────────────────────────────────
  // Bulk-creates up to 50 products. Handler: uploadCatalogHandler (onboarding-mutations.ts).
  server.registerTool(
    "upload_catalog",
    {
      title: "Upload catalog",
      description:
        `Use this when the owner wants to bulk-import a product list (up to ${UPLOAD_CATALOG_MAX}). For a single product, use \`create_product\`. ` +
        "Bulk-creates products in the business catalog from a structured list. " +
        `Each item needs { name, price }. Maximum ${UPLOAD_CATALOG_MAX} products per call. ` +
        "Items with an empty name or price ≤ 0 are skipped and reported in the response. " +
        "Returns { created: number, skipped: Array<{ index, name, reason }> }. " +
        "Idempotent on exact replay (same items in the same order); reordering or inserting items may re-create products. " +
        "Initial stock is 0 for all created products — call stock_load after to set initial inventory.",
      inputSchema: {
        products: z
          .array(
            z.object({
              name:  z.string().describe("Product name."),
              price: z.number().describe("Selling price in ARS."),
            }),
          )
          .min(1)
          .max(UPLOAD_CATALOG_MAX)
          .describe(`List of products to create (1–${UPLOAD_CATALOG_MAX} items).`),
      },
      // destructiveHint: true — bulk-creates product records; each created product is a persistent write.
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    async (args) => uploadCatalogHandler(businessId, args.products),
  );
}
