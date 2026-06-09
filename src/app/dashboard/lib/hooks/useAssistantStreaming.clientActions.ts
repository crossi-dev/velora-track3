"use client";

/**
 * useAssistantStreaming.clientActions.ts
 *
 * Extracted from useAssistantStreaming.ts (Fix #2) to keep that file under
 * the 400-line budget enforced by project conventions (Code Size Contract).
 *
 * Handles every server-driven clientAction value returned in the SSE
 * `complete` payload: UI pickers, navigation, MP OAuth, and
 * confirmation fast-path. The main file calls `handleClientAction` after
 * parsing the SSE response.
 */

import type { MutableRefObject } from "react";
import type { ParsedAssistantResponse } from "./assistant-chat-utils";
import type {
  AssistantConfirmationRequest,
} from "../types";

export interface ClientActionTimerRefs {
  photoPickerTimerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>;
  filePickerTimerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>;
  mpOauthTimerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>;
  pasteTextareaTimerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>;
}

export interface ClientActionOpts {
  appendTransientReply: (text: string, agentActivity?: import("../types").AgentActivity[] | null) => void;
  setAssistantReply: (msg: string | null) => void;
  setAssistantConfirmationRequest: (req: AssistantConfirmationRequest | null) => void;
  onConfirmationConfirm?: () => Promise<void> | void;
  onConfirmationCancel?: () => void;
}

export type ClientActionResult =
  | { kind: "handled_locally" }
  | { kind: "noop" };

/**
 * Dispatches server-driven clientAction side-effects (window events,
 * navigation, OAuth). Returns `handled_locally` when the action short-
 * circuits the normal response flow (confirmation fast-path); `noop`
 * for fire-and-forget actions that let the normal flow continue.
 *
 * Timer refs are passed explicitly so the caller can cancel them on unmount.
 */
export async function handleClientAction(
  data: Record<string, unknown>,
  parsed: ParsedAssistantResponse,
  pendingConfirmationSnapshot: AssistantConfirmationRequest | null,
  timerRefs: ClientActionTimerRefs,
  opts: ClientActionOpts,
): Promise<ClientActionResult> {
  if (typeof data.clientAction !== "string") return { kind: "noop" };
  if (typeof window === "undefined") return { kind: "noop" };

  const action = data.clientAction;

  // ── Photo picker ─────────────────────────────────────────────────────────
  // Server-driven open of the onboarding photo picker — supervisor emits
  // clientAction:"open_photo_picker" when the dueño picks "foto" in the
  // product-loading (T5) or customer-loading (T12) menu.
  // clientActionParams.context routes to the correct extraction endpoint:
  //   "products" (default) → /api/onboarding/photo-extract
  //   "customers"          → /api/onboarding/photo-extract-customers
  // Window event is consumed by AssistantAttachMenu.
  if (action === "open_photo_picker") {
    const photoContext = (data as { clientActionParams?: { context?: string } }).clientActionParams?.context ?? "products";
    if (timerRefs.photoPickerTimerRef.current !== null) clearTimeout(timerRefs.photoPickerTimerRef.current);
    timerRefs.photoPickerTimerRef.current = setTimeout(
      () => window.dispatchEvent(new CustomEvent("velora:open-photo-picker", { detail: { context: photoContext } })),
      100,
    );
  }

  // ── File picker ──────────────────────────────────────────────────────────
  // Same pattern for the Excel/CSV file picker — supervisor emits
  // clientAction:"open_file_picker" when the dueño picks "archivo"
  // in the product-loading menu. Listener lives in AssistantAttachMenu.
  if (action === "open_file_picker") {
    if (timerRefs.filePickerTimerRef.current !== null) clearTimeout(timerRefs.filePickerTimerRef.current);
    timerRefs.filePickerTimerRef.current = setTimeout(() => window.dispatchEvent(new CustomEvent("velora:open-file-picker")), 100);
  }

  // ── Paste textarea ───────────────────────────────────────────────────────
  // Onboarding T5 "Pegá tu lista" — opens an inline multi-line textarea
  // so the owner can paste a product list without leaving the chat.
  // Listener lives in AssistantPasteTextarea (or wherever the UI mounts it).
  if (action === "open_paste_textarea") {
    if (timerRefs.pasteTextareaTimerRef.current !== null) clearTimeout(timerRefs.pasteTextareaTimerRef.current);
    timerRefs.pasteTextareaTimerRef.current = setTimeout(() => window.dispatchEvent(new CustomEvent("velora:open-paste-textarea")), 100);
  }

  // ── BYOA external-account handler ────────────────────────────────────────
  // Opens the provider's official portal in a new tab so the owner can
  // authenticate directly (never through Velora). Only https:// URLs allowed.
  // Pattern: AFIP portal for CUIT delegation, Andreani Developers for token.
  if (action === "open_external_account") {
    const params = (data as { clientActionParams?: { url?: unknown; service?: unknown } }).clientActionParams;
    const url = typeof params?.url === "string" ? params.url : null;
    if (url && /^https:\/\//.test(url)) {
      window.open(url, "_blank", "noopener,noreferrer");
    }
  }

  // ── open_settings ────────────────────────────────────────────────────────
  // Generic open-Settings clientAction with optional panel scroll target.
  // Used for BUSINESS DATA (CP, WhatsApp, alias, datos del negocio).
  // External SERVICE connections (MP, ARCA, Andreani, OCA, MODO, Correo)
  // use clientAction "open_servicios" instead — see below.
  //
  // Exception: panel:"contactos" is a deeplink to customer management, but
  // Customers live in the `clients` tab. Route directly to ?tab=clients.
  //
  // Migration 2026-05-25: panels that previously rerouted to tab=servicios
  // (negocio.fiscal, logistica.andreani/oca/correo) are now handled in-chat
  // via the BYOA open_external_account flow. Only negocio.mercadopago and
  // negocio.modo still redirect to servicios (they use their own OAuth/connect
  // flows, not the BYOA portal pattern).
  if (action === "open_settings") {
    const panel = typeof (data as { clientActionParams?: { panel?: unknown } }).clientActionParams?.panel === "string"
      ? (data as { clientActionParams: { panel: string } }).clientActionParams.panel
      : null;
    // BYOA panels are now in-chat — early-return without navigating.
    // The open_external_account handler above already opened the portal.
    const BYOA_PANELS = new Set([
      "negocio.fiscal",
      "logistica.andreani",
      "logistica.oca",
      "logistica.correo",
    ]);
    if (panel && BYOA_PANELS.has(panel)) {
      // No navigation — BYOA flow is fully in-chat. Intentional no-op.
    } else {
      // Service-connection panels that still use the servicios tab.
      const SERVICE_CONNECTION_PANELS = new Set([
        "negocio.modo",
        "negocio.mercadopago",
      ]);
      const url = panel === "contactos"
        ? "/dashboard?tab=clients"
        : panel && SERVICE_CONNECTION_PANELS.has(panel)
          ? `/dashboard?tab=servicios&panel=${encodeURIComponent(panel)}`
          : panel
            ? `/dashboard?tab=settings&panel=${encodeURIComponent(panel)}`
            : "/dashboard?tab=settings";
      setTimeout(() => { window.location.href = url; }, 150);
    }
  }

  // ── open_servicios ───────────────────────────────────────────────────────
  // Explicit open-Servicios clientAction — preferred path for new code
  // (post-2026-05-25). Lands on Servicios tab; optional panel param
  // identifies which provider card to highlight.
  if (action === "open_servicios") {
    const panel = typeof (data as { clientActionParams?: { panel?: unknown } }).clientActionParams?.panel === "string"
      ? (data as { clientActionParams: { panel: string } }).clientActionParams.panel
      : null;
    const url = panel
      ? `/dashboard?tab=servicios&panel=${encodeURIComponent(panel)}`
      : "/dashboard?tab=servicios";
    setTimeout(() => { window.location.href = url; }, 150);
  }

  // ── MP OAuth ─────────────────────────────────────────────────────────────
  // Onboarding T6 — MP OAuth redirect. Owner confirms "Conectar MP" and
  // the server returns clientAction:"open_mp_oauth". We navigate to the
  // connect endpoint which sets an OAuth state cookie and redirects to MP.
  // The endpoint resolves businessId from the session (cookie-based owner
  // OAuth), so no query param is needed.
  //
  // Capacitor native (Android/iOS) graceful degradation: the in-app WebView
  // cannot complete MP OAuth (MP rejects WebView UA + cookies don't bridge
  // back to the WebView from the in-app browser). Show a chat-visible
  // message instead of attempting a silent redirect that would fail.
  // Full native OAuth flow (signed state + system browser + deep link back
  // to app) is a separate work item (deferred).
  if (action === "open_mp_oauth") {
    const { isCapacitor } = await import("@/lib/capacitor-helpers");
    if (isCapacitor()) {
      opts.appendTransientReply(
        "Para conectar Mercado Pago necesito un navegador web. Abrí Velora en tu computadora o en el navegador del teléfono (Chrome) y conectalo desde Ajustes → Mercado Pago. Es por una restricción de seguridad de MP."
      );
    } else {
      if (timerRefs.mpOauthTimerRef.current !== null) clearTimeout(timerRefs.mpOauthTimerRef.current);
      timerRefs.mpOauthTimerRef.current = setTimeout(async () => {
        // Use JSON flow so the intent:// URL (Android deep-link to MP app)
        // reaches the browser via JS assignment, not a 302 Location header
        // — Chrome only triggers intent handling on direct JS navigation.
        try {
          const res = await fetch("/api/integrations/mp/connect?format=json", { credentials: "include" });
          if (!res.ok) { window.location.href = "/api/integrations/mp/connect"; return; }
          const mpData = await res.json() as { authorizationUrl?: string };
          if (typeof mpData.authorizationUrl === "string" && mpData.authorizationUrl) {
            window.location.href = mpData.authorizationUrl;
          } else {
            window.location.href = "/api/integrations/mp/connect";
          }
        } catch {
          window.location.href = "/api/integrations/mp/connect";
        }
      }, 200);
    }
  }

  // ── Confirmation fast-path ────────────────────────────────────────────────
  // The server detected sí/no while a confirmationRequest was pending and
  // short-circuited the LLM. Re-emit the card and immediately fire the
  // confirm/cancel handler so the outcome matches a button tap exactly.
  if (action === "execute_pending_confirmation" || action === "cancel_pending_confirmation") {
    const pendingFromServer = (data.pendingConfirmation as { action?: AssistantConfirmationRequest["action"] } | undefined)?.action;
    // Prefer the action snapshot the client had (richer payload); fall
    // back to the server's echo if the snapshot was lost (cross-device).
    const pendingAction = pendingConfirmationSnapshot?.action ?? pendingFromServer ?? null;
    if (action === "execute_pending_confirmation" && pendingAction) {
      opts.setAssistantConfirmationRequest(
        pendingConfirmationSnapshot ?? {
          id: typeof (data.pendingConfirmation as { id?: string } | undefined)?.id === "string"
            ? (data.pendingConfirmation as { id: string }).id
            : "server-restored",
          severity: "warning",
          title: "Confirmar",
          message: typeof parsed.assistantAnswer === "string" ? parsed.assistantAnswer : "",
          confirmLabel: "Confirmar",
          cancelLabel: "Cancelar",
          action: pendingAction,
        },
      );
      if (opts.onConfirmationConfirm) void opts.onConfirmationConfirm();
    } else if (action === "cancel_pending_confirmation") {
      if (opts.onConfirmationCancel) opts.onConfirmationCancel();
      else opts.setAssistantConfirmationRequest(null);
    }
    if (parsed.assistantAnswer) {
      opts.setAssistantReply(parsed.assistantAnswer);
      opts.appendTransientReply(parsed.assistantAnswer, parsed.agentActivity ?? null);
    }
    return { kind: "handled_locally" };
  }

  return { kind: "noop" };
}
