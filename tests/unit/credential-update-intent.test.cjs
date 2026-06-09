"use strict";
// Tests for credential-update-intent.ts — three deterministic NLU detectors.
// These are pure regex functions: no DB, no network, no mocks needed.

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  detectAliasUpdateIntent,
  detectCourierSettingsIntent,
  detectMpOAuthReconnectIntent,
  detectCredentialUpdateIntent,
} = require("../../src/app/api/business-assistant/_lib/nlu/credential-update-intent.ts");

// ── detectAliasUpdateIntent ───────────────────────────────────────────────────

test("detectAliasUpdateIntent: 'mi alias es mialias.mp' → alias_update", () => {
  const r = detectAliasUpdateIntent("mi alias es mialias.mp");
  assert.equal(r?.kind, "alias_update");
  assert.equal(r?.alias, "mialias.mp");
});

test("detectAliasUpdateIntent: 'cambiá mi alias a nuevo.alias' → alias_update", () => {
  // Alias requires a dot (detectTransferAlias contract: dot is mandatory for
  // non-CBU aliases to eliminate false positives on bare words like "ayudame").
  const r = detectAliasUpdateIntent("cambiá mi alias a nuevo.alias");
  assert.equal(r?.kind, "alias_update");
  assert.equal(r?.alias, "nuevo.alias");
});

test("detectAliasUpdateIntent: CBU 22 digits via 'actualizá el CBU a X' → alias_update", () => {
  // CHANGE_ALIAS_RE requires a preposition (a/al/en/por/:) before the value.
  // "actualizá el CBU 0720031188000038090571" (no preposition) does not match;
  // the correct fixture is "actualizá el CBU a <value>".
  const r = detectAliasUpdateIntent("actualizá el CBU a 0720031188000038090571");
  assert.equal(r?.kind, "alias_update");
  assert.equal(r?.alias, "0720031188000038090571");
});

test("detectAliasUpdateIntent: 'mi CBU es 0720031188000038090571' → alias_update", () => {
  const r = detectAliasUpdateIntent("mi CBU es 0720031188000038090571");
  assert.equal(r?.kind, "alias_update");
  assert.equal(r?.alias, "0720031188000038090571");
});

test("detectAliasUpdateIntent: 'ponele el alias a velora.pro' → alias_update", () => {
  // "ponele" matches SETUP_VERB_RE; CHANGE_ALIAS_RE matches "alias a velora.pro".
  // Alias requires a dot — "velora-pro" (hyphen-only) fails detectTransferAlias.
  // "ponele de alias velora.pro" does not match because "de" is not a recognized preposition.
  const r = detectAliasUpdateIntent("ponele el alias a velora.pro");
  assert.equal(r?.kind, "alias_update");
  assert.equal(r?.alias, "velora.pro");
});

test("detectAliasUpdateIntent: bare 'alias' → null (too short, no verb, no value)", () => {
  const r = detectAliasUpdateIntent("alias");
  assert.equal(r, null);
});

test("detectAliasUpdateIntent: 'qué es un alias' → null (no setup verb)", () => {
  const r = detectAliasUpdateIntent("qué es un alias");
  assert.equal(r, null);
});

test("detectAliasUpdateIntent: 'mi nombre es Carlos' → null (no alias/CBU mention)", () => {
  const r = detectAliasUpdateIntent("mi nombre es Carlos");
  assert.equal(r, null);
});

// ── detectCourierSettingsIntent ───────────────────────────────────────────────

test("detectCourierSettingsIntent: 'conectame Andreani' → courier_settings andreani", () => {
  const r = detectCourierSettingsIntent("conectame Andreani");
  assert.equal(r?.kind, "courier_settings");
  assert.equal(r?.provider, "andreani");
});

test("detectCourierSettingsIntent: 'quiero configurar OCA' → courier_settings oca", () => {
  const r = detectCourierSettingsIntent("quiero configurar OCA");
  assert.equal(r?.kind, "courier_settings");
  assert.equal(r?.provider, "oca");
});

test("detectCourierSettingsIntent: 'agregame Correo Argentino' → courier_settings correo", () => {
  const r = detectCourierSettingsIntent("agregame Correo Argentino");
  assert.equal(r?.kind, "courier_settings");
  assert.equal(r?.provider, "correo");
});

test("detectCourierSettingsIntent: 'conectá las credenciales de Andreani' → courier_settings andreani", () => {
  const r = detectCourierSettingsIntent("conectá las credenciales de Andreani");
  assert.equal(r?.kind, "courier_settings");
  assert.equal(r?.provider, "andreani");
});

test("detectCourierSettingsIntent: 'activá OCA' → courier_settings oca", () => {
  const r = detectCourierSettingsIntent("activá OCA");
  assert.equal(r?.kind, "courier_settings");
  assert.equal(r?.provider, "oca");
});

test("detectCourierSettingsIntent: 'andreani es lo mejor' → null (no connect verb)", () => {
  const r = detectCourierSettingsIntent("andreani es lo mejor");
  assert.equal(r, null);
});

test("detectCourierSettingsIntent: 'OCA tiene tarifas caras' → null (no connect verb)", () => {
  const r = detectCourierSettingsIntent("OCA tiene tarifas caras");
  assert.equal(r, null);
});

test("detectCourierSettingsIntent: 'conectame con un cliente' → null (no courier mention)", () => {
  const r = detectCourierSettingsIntent("conectame con un cliente");
  assert.equal(r, null);
});

// ── detectMpOAuthReconnectIntent ──────────────────────────────────────────────

test("detectMpOAuthReconnectIntent: 'reconectar Mercado Pago' → mp_oauth_reconnect", () => {
  const r = detectMpOAuthReconnectIntent("reconectar Mercado Pago");
  assert.equal(r?.kind, "mp_oauth_reconnect");
});

test("detectMpOAuthReconnectIntent: 'vincular MP' → mp_oauth_reconnect", () => {
  // "renovar" does not match MP_RECONNECT_RE (which only handles "renueva/renuevá").
  // "vincular" matches both MP_RECONNECT_RE and MP_CONNECT_RE; use it instead.
  const r = detectMpOAuthReconnectIntent("vincular MP");
  assert.equal(r?.kind, "mp_oauth_reconnect");
});

test("detectMpOAuthReconnectIntent: 'vincular Mercado Pago de nuevo' → mp_oauth_reconnect", () => {
  const r = detectMpOAuthReconnectIntent("vincular Mercado Pago de nuevo");
  assert.equal(r?.kind, "mp_oauth_reconnect");
});

test("detectMpOAuthReconnectIntent: 'conectame con Mercado Pago' → mp_oauth_reconnect", () => {
  const r = detectMpOAuthReconnectIntent("conectame con Mercado Pago");
  assert.equal(r?.kind, "mp_oauth_reconnect");
});

test("detectMpOAuthReconnectIntent: 'reconectá MP' → mp_oauth_reconnect", () => {
  const r = detectMpOAuthReconnectIntent("reconectá MP");
  assert.equal(r?.kind, "mp_oauth_reconnect");
});

test("detectMpOAuthReconnectIntent: 'vendí en Mercado Pago' → null (no reconnect verb)", () => {
  const r = detectMpOAuthReconnectIntent("vendí en Mercado Pago");
  assert.equal(r, null);
});

test("detectMpOAuthReconnectIntent: 'el cliente pagó por MP' → null (no reconnect verb)", () => {
  const r = detectMpOAuthReconnectIntent("el cliente pagó por MP");
  assert.equal(r, null);
});

test("detectMpOAuthReconnectIntent: 'reconectar el wifi' → null (no MP mention)", () => {
  const r = detectMpOAuthReconnectIntent("reconectar el wifi");
  assert.equal(r, null);
});

// ── detectCredentialUpdateIntent (umbrella) ───────────────────────────────────

test("umbrella: alias_update has priority over courier_settings", () => {
  // A phrase that mentions both alias and a courier connect verb — alias wins.
  const r = detectCredentialUpdateIntent("cambiá mi alias a mitienda.mp");
  assert.equal(r?.kind, "alias_update");
});

test("umbrella: courier_settings has priority over mp_oauth_reconnect", () => {
  // OCA with connect verb — does NOT mention MP, so courier wins if no alias.
  const r = detectCredentialUpdateIntent("conectame OCA");
  assert.equal(r?.kind, "courier_settings");
  assert.equal(r?.provider, "oca");
});

test("umbrella: falls through to mp_oauth_reconnect when no alias or courier match", () => {
  const r = detectCredentialUpdateIntent("reconectar Mercado Pago");
  assert.equal(r?.kind, "mp_oauth_reconnect");
});

test("umbrella: returns null when nothing matches", () => {
  const r = detectCredentialUpdateIntent("cuánto stock tengo");
  assert.equal(r, null);
});
