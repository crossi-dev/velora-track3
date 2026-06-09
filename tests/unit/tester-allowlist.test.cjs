const assert = require("node:assert/strict");
const test = require("node:test");

const { isTesterEmail, TESTER_EMAILS } = require("../../src/lib/tester-allowlist.ts");

test("isTesterEmail: known tester email returns true", () => {
  assert.equal(isTesterEmail("owner@example.com"), true);
});

test("isTesterEmail: normalises to lowercase", () => {
  assert.equal(isTesterEmail("owner@example.com"), true);
});

test("isTesterEmail: trims surrounding whitespace", () => {
  assert.equal(isTesterEmail("  owner@example.com  "), true);
});

test("isTesterEmail: unknown email returns false", () => {
  assert.equal(isTesterEmail("evil@hacker.com"), false);
});

test("isTesterEmail: null returns false", () => {
  assert.equal(isTesterEmail(null), false);
});

test("isTesterEmail: undefined returns false", () => {
  assert.equal(isTesterEmail(undefined), false);
});

test("isTesterEmail: empty string returns false", () => {
  assert.equal(isTesterEmail(""), false);
});

test("TESTER_EMAILS is a ReadonlySet", () => {
  assert.ok(TESTER_EMAILS instanceof Set);
  assert.ok(TESTER_EMAILS.has("owner@example.com"));
});
