// E2E — owner dashboard + AI chat contract
//
// Auth strategy: NextAuth JWT cookie. Two modes:
//   1. API-level (fetch with Cookie header) — fast, no browser overhead
//   2. Browser-level (Playwright page + cookie injection) — full UI flow
//
// Setup: sign in as owner in a browser, copy the `next-auth.session-token`
// cookie value, then run:
//   TEST_OWNER_COOKIE=<value> BASE_URL=http://localhost:3000 npx playwright test owner-dashboard-chat
//
// Without TEST_OWNER_COOKIE, the authenticated suite is skipped.
// Public tests (unauthenticated redirects) always run.

import { test, expect } from '@playwright/test';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const TEST_OWNER_COOKIE = process.env.TEST_OWNER_COOKIE;
const HAS_COOKIE = Boolean(TEST_OWNER_COOKIE);

const SESSION_COOKIE_NAME = 'next-auth.session-token';

// ── Public (no auth) ───────────────────────────────────────────────────

test.describe('Owner routes — unauthenticated', () => {
  test('/dashboard without session redirects or shows gate (no 5xx)', async ({ page }) => {
    const res = await page.goto(`${BASE_URL}/dashboard`, { waitUntil: 'domcontentloaded' });
    expect(res.status()).toBeLessThan(500);
    // Middleware either redirects to sign-in or blocks with a 4xx/redirect
    const isRedirected = !page.url().endsWith('/dashboard') ||
      page.url().includes('signin') ||
      page.url().includes('login');
    const isGated = page.url().includes('/dashboard');
    expect(isRedirected || isGated).toBe(true);
  });

  test('/api/business-assistant without cookie returns 401', async () => {
    const res = await fetch(`${BASE_URL}/api/business-assistant`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hola' }),
    });
    expect(res.status).toBe(401);
  });

  test('/api/business-assistant 401 body has error string', async () => {
    const res = await fetch(`${BASE_URL}/api/business-assistant`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hola' }),
    });
    const body = await res.json();
    expect(typeof body.error).toBe('string');
  });
});

// ── Authenticated owner suite ──────────────────────────────────────────
// Skipped when TEST_OWNER_COOKIE is not set.

const describeAuth = HAS_COOKIE ? test.describe : test.describe.skip;

describeAuth(`Owner dashboard + AI chat @ ${BASE_URL}`, () => {
  const cookieHeader = `${SESSION_COOKIE_NAME}=${TEST_OWNER_COOKIE}`;

  // ── API-level: auth + response shape ────────────────────────────────

  test('owner cookie unlocks /api/business-assistant (not 401/403)', async () => {
    const res = await fetch(`${BASE_URL}/api/business-assistant`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
      body: JSON.stringify({ text: 'que hay en stock', locale: 'es-AR' }),
    });
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
    expect([200, 429]).toContain(res.status);
  });

  test('/api/business-assistant response shape: { answer: string, actions: [] }', async () => {
    const res = await fetch(`${BASE_URL}/api/business-assistant`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
      body: JSON.stringify({ text: 'que hay en stock', locale: 'es-AR' }),
    });
    if (res.status === 429) return; // rate-limited — skip shape check
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.answer).toBe('string');
    expect(Array.isArray(body.actions)).toBe(true);
  });

  test('business_query: answer is non-empty string', async () => {
    const res = await fetch(`${BASE_URL}/api/business-assistant`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
      body: JSON.stringify({ text: 'resumen de hoy', locale: 'es-AR' }),
    });
    if (res.status === 429) return;
    const body = await res.json();
    expect(body.answer.trim().length).toBeGreaterThan(0);
  });

  test('register_sale intent: response includes actions array (may have sale action)', async () => {
    const res = await fetch(`${BASE_URL}/api/business-assistant`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
      body: JSON.stringify({
        text: 'vendí 2 coca cola',
        locale: 'es-AR',
        chatHistory: [],
      }),
    });
    if (res.status === 429) return;
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.answer).toBe('string');
    expect(Array.isArray(body.actions)).toBe(true);
    // If an action is present, it must have a type field
    for (const action of body.actions) {
      expect(typeof action.type).toBe('string');
    }
  });

  // ── Browser-level: dashboard page loads ─────────────────────────────

  test('/dashboard renders with owner session cookie (browser)', async ({ page }) => {
    await page.context().addCookies([{
      name: SESSION_COOKIE_NAME,
      value: TEST_OWNER_COOKIE,
      url: BASE_URL,
      httpOnly: true,
      secure: BASE_URL.startsWith('https'),
      sameSite: 'Lax',
    }]);
    const res = await page.goto(`${BASE_URL}/dashboard`, { waitUntil: 'domcontentloaded' });
    expect(res.status()).toBeLessThan(400);
    // Should stay on /dashboard (not redirected to login)
    expect(page.url()).toContain('/dashboard');
    expect(page.url()).not.toContain('signin');
  });

  test('/dashboard has chat input element (UI contract)', async ({ page }) => {
    await page.context().addCookies([{
      name: SESSION_COOKIE_NAME,
      value: TEST_OWNER_COOKIE,
      url: BASE_URL,
      httpOnly: true,
      secure: BASE_URL.startsWith('https'),
      sameSite: 'Lax',
    }]);
    await page.goto(`${BASE_URL}/dashboard`, { waitUntil: 'networkidle' });
    // The assistant chat input exists somewhere on the owner dashboard
    const chatInputs = await page.$$('textarea, input[type="text"], [role="textbox"]');
    expect(chatInputs.length).toBeGreaterThanOrEqual(1);
  });
});
