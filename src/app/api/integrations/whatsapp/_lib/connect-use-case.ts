// connect-use-case.ts — WhatsApp Business connect + disconnect use-cases.
//
// Connect: exchange an Embedded Signup code for a Business Integration System
// User (BISU) token, encrypt it with the same AES-256-GCM cipher used by
// MpConnection (mp-token-cipher.ts, key: MP_TOKEN_ENCRYPTION_KEY), upsert
// WabaConnection, and subscribe the WABA to the app webhook.
//
// Disconnect: delete the WabaConnection row.
//
// Sources:
//   Meta BISU token exchange:
//     https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-customers-as-a-tech-provider#step-3--exchange-code-for-a-business-integration-system-user-access-token
//   Subscribe WABA to webhook:
//     https://developers.facebook.com/docs/graph-api/webhooks/getting-started#subscribing-to-webhooks

import { cloudLog } from "@/lib/cloud-logger";
import { prisma } from "@/lib/prisma";
import { encrypt } from "@/infrastructure/crypto/mp-token-cipher";
import { recordCriticalWriteEvent } from "@/infrastructure/shared/critical-write-audit";
import { getServerActionMeta } from "@/app/api/_lib/mutation-contract";

const CONNECT_META = getServerActionMeta("waba_connection.connect");
const DISCONNECT_META = getServerActionMeta("waba_connection.disconnect");

const GRAPH_API_VERSION = "v21.0";
const HTTP_TIMEOUT_MS = 10_000;

// ─── Config ─────────────────────────────────────────────────────────────────

function getWabaConfig(): { appId: string; appSecret: string } | null {
  const appId = process.env.WHATSAPP_APP_ID;
  const appSecret = process.env.WHATSAPP_APP_SECRET;
  if (!appId || !appSecret) return null;
  return { appId, appSecret };
}

// ─── Token exchange ──────────────────────────────────────────────────────────

async function exchangeCodeForBisuToken(
  code: string,
  appId: string,
  appSecret: string,
): Promise<{ ok: true; accessToken: string } | { ok: false; error: string }> {
  const url = new URL(`https://graph.facebook.com/${GRAPH_API_VERSION}/oauth/access_token`);
  url.searchParams.set("client_id", appId);
  url.searchParams.set("client_secret", appSecret);
  url.searchParams.set("code", code);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url.toString(), { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }

  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    // non-JSON body
  }

  if (!res.ok || !isTokenResponse(parsed)) {
    const errMsg = extractError(parsed);
    cloudLog({
      severity: "ERROR",
      component: "WhatsApp",
      action: "WABA_TOKEN_EXCHANGE_FAILED",
      a2a_transfer: false,
      message: `BISU token exchange failed: httpStatus=${res.status} error=${errMsg}`,
      data: { httpStatus: res.status },
    });
    return { ok: false, error: errMsg };
  }
  return { ok: true, accessToken: parsed.access_token };
}

function isTokenResponse(v: unknown): v is { access_token: string } {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as Record<string, unknown>).access_token === "string"
  );
}

function extractError(v: unknown): string {
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.error === "string") return o.error;
    if (o.error && typeof o.error === "object") {
      const inner = o.error as Record<string, unknown>;
      if (typeof inner.message === "string") return inner.message;
    }
    if (typeof o.message === "string") return o.message;
  }
  return "unknown_error";
}

// ─── Webhook subscription ────────────────────────────────────────────────────

async function subscribeWabaToWebhook(wabaId: string, accessToken: string): Promise<void> {
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${wabaId}/subscribed_apps`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: controller.signal,
    });
    if (!res.ok) {
      cloudLog({
        severity: "WARNING",
        component: "WhatsApp",
        action: "WABA_WEBHOOK_SUBSCRIBE_FAILED",
        a2a_transfer: false,
        message: `WABA webhook subscription returned ${res.status} — continuing anyway`,
        data: { wabaId, httpStatus: res.status },
      });
    }
  } finally {
    clearTimeout(timer);
  }
}

// ─── Connect ─────────────────────────────────────────────────────────────────

export interface ConnectWabaInput {
  businessId: string;
  actorUserId: string;
  actorEmployeeId: string | null;
  code: string;
  wabaId: string;
  phoneNumberId: string;
}

export type ConnectWabaResult =
  | { outcome: "connected"; wabaId: string; phoneNumberId: string }
  | { outcome: "not_configured" }
  | { outcome: "token_exchange_failed"; error: string };

export async function connectWabaUseCase(
  input: ConnectWabaInput,
): Promise<ConnectWabaResult> {
  const cfg = getWabaConfig();
  if (!cfg) return { outcome: "not_configured" };

  const exchanged = await exchangeCodeForBisuToken(input.code, cfg.appId, cfg.appSecret);
  if (!exchanged.ok) {
    return { outcome: "token_exchange_failed", error: exchanged.error };
  }

  const accessTokenCiphertext = encrypt(exchanged.accessToken);
  const now = new Date();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- WabaConnection added in migration 20260528100000; Prisma client regen blocked on Windows DLL lock in worktree.
  await (prisma as any).wabaConnection.upsert({
    where: { businessId: input.businessId },
    create: {
      businessId: input.businessId,
      wabaId: input.wabaId,
      phoneNumberId: input.phoneNumberId,
      accessTokenCiphertext,
      connectedAt: now,
    },
    update: {
      wabaId: input.wabaId,
      phoneNumberId: input.phoneNumberId,
      accessTokenCiphertext,
      connectedAt: now,
    },
  });

  // Subscribe WABA to app webhook (best-effort — connection is already recorded).
  await subscribeWabaToWebhook(input.wabaId, exchanged.accessToken);

  await recordCriticalWriteEvent({
    client: prisma,
    businessId: input.businessId,
    actorUserId: input.actorUserId,
    actorEmployeeId: input.actorEmployeeId,
    routeScope: CONNECT_META.routeScope,
    actionType: CONNECT_META.actionType,
    resourceType: CONNECT_META.resourceType,
    resourceId: input.wabaId,
    summary: `WhatsApp Business connected (wabaId=${input.wabaId})`,
    payload: { wabaId: input.wabaId, phoneNumberId: input.phoneNumberId },
  });

  return { outcome: "connected", wabaId: input.wabaId, phoneNumberId: input.phoneNumberId };
}

// ─── Disconnect ──────────────────────────────────────────────────────────────

export interface DisconnectWabaInput {
  businessId: string;
  actorUserId: string;
  actorEmployeeId: string | null;
}

export type DisconnectWabaResult =
  | { outcome: "disconnected"; wabaId: string }
  | { outcome: "not_connected" };

export async function disconnectWabaUseCase(
  input: DisconnectWabaInput,
): Promise<DisconnectWabaResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- WabaConnection added in migration 20260528100000; Prisma client regen blocked on Windows DLL lock in worktree.
  const existing = await (prisma as any).wabaConnection.findUnique({
    where: { businessId: input.businessId },
    select: { wabaId: true },
  }) as { wabaId: string } | null;

  if (!existing) return { outcome: "not_connected" };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- same reason as above
  await (prisma as any).wabaConnection.delete({ where: { businessId: input.businessId } });

  await recordCriticalWriteEvent({
    client: prisma,
    businessId: input.businessId,
    actorUserId: input.actorUserId,
    actorEmployeeId: input.actorEmployeeId,
    routeScope: DISCONNECT_META.routeScope,
    actionType: DISCONNECT_META.actionType,
    resourceType: DISCONNECT_META.resourceType,
    resourceId: existing.wabaId,
    summary: `WhatsApp Business disconnected (wabaId=${existing.wabaId})`,
    payload: { wabaId: existing.wabaId },
  });

  return { outcome: "disconnected", wabaId: existing.wabaId };
}
