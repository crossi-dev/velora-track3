const assert = require("node:assert/strict");
const test = require("node:test");
const { getExpectedTwilioSignature } = require("twilio");

const {
  isValidTwilioWebhookSignature,
} = require("../../src/lib/twilio-webhook-signature.ts");

// buildTwilioSignaturePayload and buildTwilioWebhookSignature were removed in
// refactor(twilio): replace custom HMAC with official twilio SDK validateRequest
// (commit 51acdbc9, 2026-05-26). The module now delegates entirely to the Twilio
// SDK's validateRequest. Tests cover the public isValidTwilioWebhookSignature API.

const TEST_AUTH_TOKEN = "twilio-auth-token-test";
const TEST_URL = "https://velora.app/api/whatsapp/webhook";
const TEST_PARAMS = {
  From: "whatsapp:+5491111111111",
  Body: "hola",
  MessageSid: "SM123",
};

test("isValidTwilioWebhookSignature: acepta una firma válida generada por el SDK", () => {
  const signature = getExpectedTwilioSignature(TEST_AUTH_TOKEN, TEST_URL, TEST_PARAMS);
  assert.equal(
    isValidTwilioWebhookSignature(TEST_AUTH_TOKEN, signature, TEST_URL, TEST_PARAMS),
    true
  );
});

test("isValidTwilioWebhookSignature: rechaza una firma inválida", () => {
  assert.equal(
    isValidTwilioWebhookSignature(TEST_AUTH_TOKEN, "firma-invalida", TEST_URL, TEST_PARAMS),
    false
  );
});

test("isValidTwilioWebhookSignature: rechaza cuando la firma es null", () => {
  assert.equal(
    isValidTwilioWebhookSignature(TEST_AUTH_TOKEN, null, TEST_URL, TEST_PARAMS),
    false
  );
});

test("isValidTwilioWebhookSignature: rechaza cuando la firma es undefined", () => {
  assert.equal(
    isValidTwilioWebhookSignature(TEST_AUTH_TOKEN, undefined, TEST_URL, TEST_PARAMS),
    false
  );
});

test("isValidTwilioWebhookSignature: rechaza firma válida con URL diferente", () => {
  const signature = getExpectedTwilioSignature(TEST_AUTH_TOKEN, TEST_URL, TEST_PARAMS);
  assert.equal(
    isValidTwilioWebhookSignature(
      TEST_AUTH_TOKEN,
      signature,
      "https://velora.app/api/whatsapp/other",
      TEST_PARAMS
    ),
    false
  );
});
