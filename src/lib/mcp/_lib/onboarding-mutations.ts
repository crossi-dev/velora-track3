// src/lib/mcp/_lib/onboarding-mutations.ts — Shared handler logic for onboarding MCP tools.
//
// Extracted from onboarding-tools.ts to keep that file under the 300-line limit.
// Contains:
//   - E.164 phone validation + normalization (connect_whatsapp)
//   - connectPedidosYaByoaHandler: BYOA secure-form + optional token fallback (connect_pedidosya)
//   - connectWhatsappByoaHandler: BYOA Meta Embedded Signup link + optional phone pre-step
//   - uploadCatalogHandler: bulk product creation (upload_catalog)
//   - Shared constants: UPLOAD_CATALOG_MAX
//   - errResponse: re-exported from mcp-responses.ts (canonical)
//
// References:
//   ITU-T E.164: https://www.itu.int/rec/T-REC-E.164
//   createOnboardingProduct: src/app/api/supervisor/_lib/onboarding-product-actions.ts

import { prisma } from "@/lib/prisma";
import { recordCriticalWriteEvent } from "@/infrastructure/shared/critical-write-audit";
import {
  createOnboardingProduct,
  clearPendingStockProduct,
} from "@/app/api/supervisor/_lib/onboarding-product-actions";
import { connectPedidosYa } from "@/app/api/integrations/comunicaciones/connect/_lib/pedidosya-connect-core";
import { MCP_ACTOR_USER_ID } from "./catalog-mutations";

// ── E.164 validation ──────────────────────────────────────────────────────────
// ITU-T E.164: + followed by 7–15 digits.
// Source: https://www.itu.int/rec/T-REC-E.164

const E164_RE = /^\+\d{7,15}$/;

export function isValidE164(phone: string): boolean {
  return E164_RE.test(phone);
}

/** Normalize a phone string to E.164 — accepts an already-valid E.164. */
export function normalizePhone(raw: string): string | null {
  const trimmed = raw.trim();
  return isValidE164(trimmed) ? trimmed : null;
}

// ── Catalog upload cap ────────────────────────────────────────────────────────
// Mirrors onboarding-fast-path.bulk-parser.ts BULK_MAX_PRODUCTS = 50.

export const UPLOAD_CATALOG_MAX = 50;

// ── Shared error helper ───────────────────────────────────────────────────────
export { errResponse } from "./mcp-responses";
import { errResponse } from "./mcp-responses";

// ── connect_whatsapp handler ──────────────────────────────────────────────────

export type ConnectWhatsappResult =
  | ReturnType<typeof errResponse>
  | { content: [{ type: "text"; text: string }] };

export async function connectWhatsappHandler(
  businessId: string,
  rawPhone: string,
): Promise<ConnectWhatsappResult> {
  const phone = normalizePhone(rawPhone);
  if (!phone) {
    return errResponse(
      "INVALID_PHONE",
      `El teléfono debe estar en formato E.164 (ej. +5491100000000). Recibido: "${rawPhone}"`,
    );
  }

  try {
    await prisma.business.update({
      where: { id: businessId },
      data:  { whatsappBusinessPhoneE164: phone },
    });
  } catch {
    return errResponse("SAVE_FAILED", "No se pudo guardar el número. Reintentá.");
  }

  await recordCriticalWriteEvent({
    client:          prisma,
    businessId,
    actorUserId:     MCP_ACTOR_USER_ID,
    actorEmployeeId: null,
    routeScope:      "mcp/onboarding/connect-whatsapp",
    actionType:      "business.update",
    resourceType:    "business",
    resourceId:      businessId,
    summary:         "WhatsApp Business phone capturado vía MCP",
    payload:         { field: "whatsappBusinessPhoneE164" },
  });

  return {
    content: [{ type: "text" as const, text: JSON.stringify({ ok: true, phone }) }],
  };
}

// ── Base URL helper (mirrors connection-tools.ts serviciosUrl) ────────────────
// Duplicated here to avoid a circular import — onboarding-tools → this file →
// connection-tools → (no onboarding dependency). The pattern is stable:
//   ${VELORA_APP_URL}/dashboard?tab=servicios&provider=<key>

function serviciosDeepLink(provider: string): string {
  const base = (process.env.VELORA_APP_URL ?? "https://somosvelora.com").replace(/\/$/, "");
  return `${base}/dashboard?tab=servicios&provider=${provider}`;
}

// ── connect_pedidosya BYOA handler ────────────────────────────────────────────

type McpToolContent = { content: [{ type: "text"; text: string }] };
type McpToolError   = ReturnType<typeof errResponse>;
type McpToolResult  = McpToolContent | McpToolError;

/**
 * BYOA handler for connect_pedidosya.
 *
 * Primary (apiToken omitted): returns a secure-form link to the Servicios tab
 *   so the owner enters their PedidosYa token on Velora's protected HTTPS page.
 * Fallback (apiToken supplied): encrypts + upserts the token via the shared
 *   connectPedidosYa core (same as the HTTP route).
 *
 * PedidosYa has no OAuth flow — their partner portal issues an opaque token.
 * A dedicated form route does not yet exist (gap); the generic Servicios link
 *   (provider=pedidosya) is the correct current target.
 *
 * Reuses: connectPedidosYa (pedidosya-connect-core.ts — shared with HTTP route)
 */
export async function connectPedidosYaByoaHandler(
  businessId: string,
  apiToken: string | undefined,
): Promise<McpToolResult> {
  if (apiToken !== undefined) {
    const result = await connectPedidosYa({ businessId, actorUserId: MCP_ACTOR_USER_ID, apiToken });
    if (!result.ok) return errResponse(result.code, result.message);
    return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true }) }] };
  }

  // Primary: secure-form link (no token through chat/LLM)
  const connectUrl = serviciosDeepLink("pedidosya");
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({
        ok: true,
        action: "connect_form",
        connectUrl,
        instructions:
          "Abrí este link para conectar PedidosYa de forma segura. " +
          "Vas a cargar tu token en una página web protegida — nunca en el chat.",
      }),
    }],
  };
}

// ── connect_whatsapp BYOA handler ─────────────────────────────────────────────

/**
 * BYOA handler for connect_whatsapp.
 *
 * Primary (phone omitted): returns a link to the Velora Servicios tab
 *   (provider=whatsapp) which launches Meta's official Embedded Signup popup.
 *   Meta's JS SDK popup cannot run from an MCP tool — the browser page is
 *   required. On completion the dashboard POSTs to /api/integrations/whatsapp/connect
 *   which completes the WABA token exchange server-side.
 *
 * Optional phone pre-step (phone supplied): captures Business.whatsappBusinessPhoneE164
 *   via connectWhatsappHandler AND returns the Meta signup link for the full
 *   WABA connection (both steps in one call).
 *
 * Reuses: connectWhatsappHandler (this file, phone-capture only)
 */
export async function connectWhatsappByoaHandler(
  businessId: string,
  phone: string | undefined,
): Promise<McpToolResult> {
  const connectUrl = serviciosDeepLink("whatsapp");

  if (phone !== undefined) {
    const phoneResult = await connectWhatsappHandler(businessId, phone);
    // Propagate validation / save failures — don't return a link on bad input.
    if ("isError" in phoneResult && phoneResult.isError) return phoneResult;
    const parsed = JSON.parse(
      (phoneResult as McpToolContent).content[0].text,
    ) as { ok: boolean; phone: string };
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          ok: true,
          action: "authorize",
          connectUrl,
          phone: parsed.phone,
          instructions:
            "Número registrado. Ahora abrí este link para conectar tu WhatsApp Business. " +
            "Vas a autorizar en el sitio oficial de Meta (Facebook); Velora nunca ve tu contraseña.",
        }),
      }],
    };
  }

  // Primary: return Meta Embedded Signup link (no credential through tool)
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({
        ok: true,
        action: "authorize",
        connectUrl,
        instructions:
          "Abrí este link para conectar tu WhatsApp Business. " +
          "Vas a autorizar en el sitio oficial de Meta (Facebook); Velora nunca ve tu contraseña.",
      }),
    }],
  };
}

// ── upload_catalog handler ────────────────────────────────────────────────────

type CatalogItem = { name: string; price: number };
type SkippedItem = { index: number; name: string; reason: string };

export async function uploadCatalogHandler(
  businessId: string,
  products: CatalogItem[],
): Promise<{ content: [{ type: "text"; text: string }] }> {
  const skipped: SkippedItem[] = [];
  let created = 0;

  for (let i = 0; i < products.length; i++) {
    const item = products[i];
    const name = typeof item?.name === "string" ? item.name.trim() : "";
    const price = typeof item?.price === "number" ? item.price : NaN;

    if (!name) {
      skipped.push({ index: i, name: item?.name ?? "", reason: "empty name" });
      continue;
    }
    if (!Number.isFinite(price) || price <= 0) {
      skipped.push({ index: i, name, reason: "price must be a positive number" });
      continue;
    }

    const idempSeed = `mcp:upload_catalog:${businessId}:${i}:${name}:${price}`;
    try {
      await createOnboardingProduct({
        businessId,
        actorUserId: MCP_ACTOR_USER_ID,
        idempotencySeed: idempSeed,
        name,
        price,
      });
      // Count every item that passed validation as created (includes idempotent
      // replays — the product is in the catalog either way; null return = replay).
      created++;
    } catch {
      // DB failure mid-loop — report as skipped so partial success is accurate.
      skipped.push({ index: i, name, reason: "error de guardado" });
    }
  }

  // Clear pendingStockProductId left by the last createOnboardingProduct call.
  // createOnboardingProduct sets pendingStockProductId on each product it creates;
  // without this clear the owner's next chat turn gets hijacked into a stock prompt
  // for the last uploaded item. Mirrors the bulk-import path in
  // owner-handler.stages-onboarding.ts (~line 121).
  if (created > 0) {
    await clearPendingStockProduct({
      businessId,
      actorUserId: MCP_ACTOR_USER_ID,
      idempotencySeed: `mcp:upload_catalog:${businessId}:clear-pending`,
    });
  }

  return {
    content: [{ type: "text" as const, text: JSON.stringify({ created, skipped }) }],
  };
}
