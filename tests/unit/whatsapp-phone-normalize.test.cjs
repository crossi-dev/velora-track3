const assert = require("node:assert/strict");
const test = require("node:test");

// The normalizer is module-private — we exercise it indirectly through
// `sendWhatsAppMessage` by stubbing global.fetch and asserting what gets sent
// to the wire. This keeps the test honest: it covers the actual path numbers
// take in production (including the Meta + Twilio bodies), not a re-export.
const { sendWhatsAppMessage } = require("../../src/lib/whatsapp.ts");

function captureMetaTo(phone) {
  const originalFetch = global.fetch;
  const originalProvider = process.env.WHATSAPP_PROVIDER;
  const originalToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const originalPnid = process.env.WHATSAPP_PHONE_NUMBER_ID;

  process.env.WHATSAPP_PROVIDER = "meta";
  process.env.WHATSAPP_ACCESS_TOKEN = "test-token";
  process.env.WHATSAPP_PHONE_NUMBER_ID = "test-pnid";

  let capturedTo;
  global.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    capturedTo = body.to;
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };

  return {
    async run() {
      await sendWhatsAppMessage(phone, "hello");
      return capturedTo;
    },
    restore() {
      global.fetch = originalFetch;
      if (originalProvider === undefined) delete process.env.WHATSAPP_PROVIDER;
      else process.env.WHATSAPP_PROVIDER = originalProvider;
      if (originalToken === undefined) delete process.env.WHATSAPP_ACCESS_TOKEN;
      else process.env.WHATSAPP_ACCESS_TOKEN = originalToken;
      if (originalPnid === undefined) delete process.env.WHATSAPP_PHONE_NUMBER_ID;
      else process.env.WHATSAPP_PHONE_NUMBER_ID = originalPnid;
    },
  };
}

async function expectNormalized(input, expected) {
  const cap = captureMetaTo(input);
  try {
    const got = await cap.run();
    assert.equal(got, expected, `input=${JSON.stringify(input)} → expected ${expected}, got ${got}`);
  } finally {
    cap.restore();
  }
}

test("normalize: +5491112345678 → +5491112345678 (already canonical)", async () => {
  await expectNormalized("+5491112345678", "+5491112345678");
});

test("normalize: +541112345678 → +5491112345678 (inject 9 after 54)", async () => {
  await expectNormalized("+541112345678", "+5491112345678");
});

test("normalize: 541112345678 → +5491112345678 (no plus, inject 9)", async () => {
  await expectNormalized("541112345678", "+5491112345678");
});

test("normalize: 5491112345678 → +5491112345678 (no plus, already has 9)", async () => {
  await expectNormalized("5491112345678", "+5491112345678");
});

test("normalize: 11-1234-5678 → +5491112345678 (dashes stripped, AR mobile assumed)", async () => {
  await expectNormalized("11-1234-5678", "+5491112345678");
});

test("normalize: (11) 1234 5678 → +5491112345678 (parens/spaces stripped, AR mobile assumed)", async () => {
  await expectNormalized("(11) 1234 5678", "+5491112345678");
});

test("normalize: 1112345678 → +5491112345678 (bare local digits → AR mobile)", async () => {
  await expectNormalized("1112345678", "+5491112345678");
});

test("normalize: empty string throws", async () => {
  // sendWhatsAppMessage guards the trim() first ("Hace falta el teléfono...").
  // We want to hit the normalizer's "at least one digit" path, so pass a
  // non-empty input that becomes empty after digit-stripping.
  const cap = captureMetaTo("---");
  try {
    await assert.rejects(cap.run(), /al menos un dígito/);
  } finally {
    cap.restore();
  }
});

test("normalize: non-AR number (+14155551234) is preserved untouched", async () => {
  // CRITICAL: the helper must NOT inject `9` into any number that isn't
  // Argentine. If this test fails, the fix would break US/global delivery.
  await expectNormalized("+14155551234", "+14155551234");
});
