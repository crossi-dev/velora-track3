// credential-update-intent.ts — Deterministic NLU for post-onboarding credential
// updates via chat. Three intents:
//
//   alias_update       — "mi alias es X" / "cambiá mi alias a X" / "actualizá el CBU"
//   courier_settings   — "conectame Andreani" / "quiero configurar OCA" (→ open Settings panel)
//   mp_oauth_reconnect — "reconectar Mercado Pago" / "renovar MP"
//
// Contract:
//   - Accepts raw (non-normalized) text; normalizes internally.
//   - Returns null on no match — dispatcher falls through to LLM.
//   - Never captures raw secrets (clientId, secret, accessToken).
//   - alias_update reuses detectTransferAlias validator (CBU 22-digit or alias format).

import { normalizeForMatching } from "../shared";
import { detectTransferAlias } from "../onboarding-fast-path.parsers.providers";

// ── Types ─────────────────────────────────────────────────────────────────────

export type CourierProvider = "andreani" | "oca" | "correo";

export interface AliasUpdateIntent {
  kind: "alias_update";
  /** Validated alias or CBU string (from detectTransferAlias). */
  alias: string;
}

export interface CourierSettingsIntent {
  kind: "courier_settings";
  /** Which courier the owner wants to configure. */
  provider: CourierProvider;
}

export interface MpOAuthReconnectIntent {
  kind: "mp_oauth_reconnect";
}

/** Generic service-connect intent for non-OAuth services (MODO + ARCA). */
export type GenericService = "modo" | "arca";

export interface ServiceConnectIntent {
  kind: "service_connect";
  service: GenericService;
}

export type CredentialUpdateIntent =
  | AliasUpdateIntent
  | CourierSettingsIntent
  | MpOAuthReconnectIntent
  | ServiceConnectIntent;

// ── Patterns ──────────────────────────────────────────────────────────────────

// Verbs: cambiá/actualizar/poner/setear — wide AR voseo tolerance.
const SETUP_VERB_RE = /\b(cambi[aá](?:r|me|le)?|actualiz[aá](?:r|me)?|pon[eé](?:r|le|me)?|set[eé]a(?:r|me)?|mod[ií]fic[aá](?:r|me)?|carg[aá](?:r|me)?)\b/i;

// "mi alias es X" / "el alias es X" / "alias nuevo X"
const MY_ALIAS_RE = /\b(?:mi|el|nuevo)\s+(?:alias|cbu)\s+(?:es|:)\s*([^\s]+)/i;
// "cambiá mi alias a X" / "actualizá el alias por X"
const CHANGE_ALIAS_RE = /\b(?:alias|cbu)\s+(?:a|al|en|por|:)\s*([^\s]+)/i;
// "mi alias es X" without verb (owner just states it)
const BARE_ALIAS_RE = /^mi\s+(?:alias|cbu)\s+(?:es|nuevo)\s+([^\s]+)/i;

// Courier connect keywords
const CONNECT_VERB_RE = /\b(conecta(?:r|me|á)?|configura(?:r|me|á)?|agrega(?:r|me|á)?|activa(?:r|me|á)?|quiero\s+(?:conectar|configurar)|como\s+(?:conecto|configuro))\b/i;
const ANDREANI_RE = /\bandreani\b/i;
const OCA_RE = /\boca\b/i;
const CORREO_RE = /\b(correo\s*argentino|correo)\b/i;
const COURIER_CRED_RE = /\b(courier|correo|env[ií]os?|log[ií]stica|credenciales)\b/i;

// MP re-connect keywords
const MP_MENTION_RE = /\b(mercado\s*pago|mp\b)\b/i;
const MP_RECONNECT_RE = /\b(reconect[aá](?:r|me)?|renuev[aá](?:r|me)?|renov[aá](?:r|me)?|volv[eé](?:r|me)?\s+a\s+conectar|vincul[aá](?:r|me)?|re-?conectar)\b/i;
const MP_CONNECT_RE = /\b(conecta(?:r|me|á)?(?:\s+de\s+nuevo)?|vincul[aá](?:r|me)?)\b/i;

// Generic-service keywords (MODO + ARCA/AFIP).
const MODO_RE = /\bmodo\b/i;
const ARCA_RE = /\b(arca|afip|factura(?:ci[oó]n|s)?)\b/i;

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractAlias(text: string): string | null {
  // Try "mi alias es X" first (bare statement)
  const bareMatch = BARE_ALIAS_RE.exec(text);
  if (bareMatch?.[1]) {
    const validated = detectTransferAlias(bareMatch[1]);
    if (validated) return validated;
  }

  // Try "... alias a X" / "... CBU a X" (after setup verb)
  const changeMatch = CHANGE_ALIAS_RE.exec(text);
  if (changeMatch?.[1]) {
    const validated = detectTransferAlias(changeMatch[1]);
    if (validated) return validated;
  }

  // Try "el alias nuevo es X" / "mi CBU es X"
  const myMatch = MY_ALIAS_RE.exec(text);
  if (myMatch?.[1]) {
    const validated = detectTransferAlias(myMatch[1]);
    if (validated) return validated;
  }

  return null;
}

function detectCourierProvider(text: string): CourierProvider | null {
  const norm = normalizeForMatching(text);
  if (ANDREANI_RE.test(norm)) return "andreani";
  if (OCA_RE.test(norm)) return "oca";
  if (CORREO_RE.test(norm)) return "correo";
  return null;
}

// ── Detectors ─────────────────────────────────────────────────────────────────

/**
 * Detects alias/CBU update intent — "mi alias es X" / "cambiá el alias a X".
 * Returns null if no valid alias found or the text doesn't match the pattern.
 * Uses detectTransferAlias to validate the format (CBU 22-digit or alias regex).
 */
export function detectAliasUpdateIntent(text: string): AliasUpdateIntent | null {
  if (!text || text.trim().length < 5) return null;
  const norm = normalizeForMatching(text);

  // Must reference alias or CBU
  const hasAliasMention = /\b(alias|cbu)\b/.test(norm);
  if (!hasAliasMention) return null;

  // Must have either a setup verb or the bare "mi alias es X" pattern
  const hasVerb = SETUP_VERB_RE.test(text) || SETUP_VERB_RE.test(norm);
  const hasBare = BARE_ALIAS_RE.test(text);
  if (!hasVerb && !hasBare) return null;

  const alias = extractAlias(text);
  if (!alias) return null;

  return { kind: "alias_update", alias };
}

/**
 * Detects courier credential setup intent.
 * Returns the matched provider and navigates to Settings panel (no raw secret capture).
 */
export function detectCourierSettingsIntent(text: string): CourierSettingsIntent | null {
  if (!text || text.trim().length < 5) return null;
  const norm = normalizeForMatching(text);

  const hasConnect = CONNECT_VERB_RE.test(text) || CONNECT_VERB_RE.test(norm);
  const hasCourierWord = COURIER_CRED_RE.test(norm);
  const provider = detectCourierProvider(norm);

  // Need either a connect verb + courier word/name, or a courier name + credential reference
  if (!provider) return null;
  if (!hasConnect && !hasCourierWord) return null;

  return { kind: "courier_settings", provider };
}

/**
 * Detects MP OAuth re-trigger intent — "reconectar Mercado Pago" / "volver a conectar MP".
 * Does NOT capture credentials — only triggers the OAuth redirect.
 */
export function detectMpOAuthReconnectIntent(text: string): MpOAuthReconnectIntent | null {
  if (!text || text.trim().length < 5) return null;
  const norm = normalizeForMatching(text);

  if (!MP_MENTION_RE.test(text) && !MP_MENTION_RE.test(norm)) return null;

  const hasReconnectVerb = MP_RECONNECT_RE.test(text) || MP_RECONNECT_RE.test(norm);
  const hasConnectVerb = MP_CONNECT_RE.test(text) || MP_CONNECT_RE.test(norm);

  if (!hasReconnectVerb && !hasConnectVerb) return null;

  return { kind: "mp_oauth_reconnect" };
}

/**
 * Detects "conectame a MODO" / "configurame MODO" — generic service connect.
 * Routes to the MODO Settings panel via open_settings clientAction.
 */
export function detectModoConnectIntent(text: string): ServiceConnectIntent | null {
  if (!text || text.trim().length < 5) return null;
  const norm = normalizeForMatching(text);
  if (!MODO_RE.test(norm)) return null;
  if (!CONNECT_VERB_RE.test(text) && !CONNECT_VERB_RE.test(norm)) return null;
  return { kind: "service_connect", service: "modo" };
}

/**
 * Detects "conectame a ARCA" / "configurame AFIP" / "quiero facturar".
 * Routes to the ARCA cert upload Settings panel.
 */
export function detectArcaConnectIntent(text: string): ServiceConnectIntent | null {
  if (!text || text.trim().length < 5) return null;
  const norm = normalizeForMatching(text);
  if (!ARCA_RE.test(norm)) return null;
  // Either a connect verb OR "quiero facturar" style phrasing.
  const wantsConnect = CONNECT_VERB_RE.test(text) || CONNECT_VERB_RE.test(norm);
  const wantsFactura = /\b(quiero|necesito|voy\s+a)\s+factur[aá]/i.test(text);
  if (!wantsConnect && !wantsFactura) return null;
  return { kind: "service_connect", service: "arca" };
}

/**
 * Umbrella detector — tries all credential-update intents in priority order.
 * alias_update > courier_settings > service_connect (MODO/ARCA) > mp_oauth_reconnect
 */
export function detectCredentialUpdateIntent(text: string): CredentialUpdateIntent | null {
  return (
    detectAliasUpdateIntent(text) ??
    detectCourierSettingsIntent(text) ??
    detectModoConnectIntent(text) ??
    detectArcaConnectIntent(text) ??
    detectMpOAuthReconnectIntent(text) ??
    null
  );
}
