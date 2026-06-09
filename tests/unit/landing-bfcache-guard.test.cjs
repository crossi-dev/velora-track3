// Regression guard for the Juan-facultad login freeze (2026-05-11).
//
// Symptom: the landing button got stuck on "Conectando…" forever after a
// user started Google OAuth and bounced back. Root cause: isSigningIn is
// local React state with no recovery path — when the browser restored the
// page from the BFCache after Google redirect, the stale true value was
// preserved and the button stayed disabled.
//
// This test verifies two things stay present in LandingPage.tsx:
//   1. A pageshow listener that resets isSigningIn on persisted=true.
//   2. A timeout safety net that resets if signIn() never navigates.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const LANDING_PATH = path.join(
  __dirname,
  "..",
  "..",
  "src",
  "app",
  "LandingPage.tsx",
);

test("LandingPage has BFCache pageshow recovery", () => {
  const src = fs.readFileSync(LANDING_PATH, "utf8");
  assert.match(
    src,
    /addEventListener\(\s*["']pageshow["']/,
    "expected pageshow listener registration",
  );
  assert.match(
    src,
    /e\.persisted/,
    "expected pageshow handler to branch on e.persisted",
  );
  assert.match(
    src,
    /setIsSigningIn\(false\)/,
    "expected setIsSigningIn(false) reset call",
  );
});

test("LandingPage has signIn timeout safety net", () => {
  const src = fs.readFileSync(LANDING_PATH, "utf8");
  assert.match(
    src,
    /setTimeout\([\s\S]*?setIsSigningIn\(false\)[\s\S]*?,\s*\d+\s*\)/,
    "expected setTimeout that resets isSigningIn after a fixed delay",
  );
});
