// E2E smoke — verifica las páginas + endpoints públicos del demo.
// No cubre flujos autenticados (Google OAuth bloquea automation, ver
// e2e/README.md). Demuestra que el contrato externo de Velora responde.

import { test, expect } from '@playwright/test';

const BASE_URL = process.env.BASE_URL || 'https://velora-000000000000.southamerica-east1.run.app';

test.describe(`Velora smoke @ ${BASE_URL}`, () => {
  test('landing page renderiza', async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });
    const title = await page.title();
    expect(title.toLowerCase()).toContain('velora');
  });

  test('/employee-login muestra form de PIN', async ({ page }) => {
    await page.goto(`${BASE_URL}/employee-login`, { waitUntil: 'networkidle' });
    const inputs = await page.$$('input');
    expect(inputs.length).toBeGreaterThanOrEqual(1);
  });

  test('/dashboard sin sesión no crashea (redirige o muestra gate)', async ({ page }) => {
    const res = await page.goto(`${BASE_URL}/dashboard`, { waitUntil: 'domcontentloaded' });
    // La middleware redirige a NEXTAUTH_URL (custom domain) cuando no hay sesión.
    // Aceptamos cualquier 2xx/3xx — el demo flow real usa OAuth real, fuera del E2E scope.
    expect(res.status()).toBeLessThan(500);
  });

  test('/api/health retorna 200 con body OK', async ({ page }) => {
    const res = await page.goto(`${BASE_URL}/api/health`, { waitUntil: 'networkidle' });
    expect(res.status()).toBe(200);
    const body = await page.content();
    expect(body.toLowerCase()).toContain('ok');
  });

  test('/api/public/vapid-key retorna publicKey runtime', async ({ page }) => {
    const res = await page.goto(`${BASE_URL}/api/public/vapid-key`, { waitUntil: 'networkidle' });
    expect(res.status()).toBe(200);
    const body = await page.content();
    expect(body).toContain('publicKey');
  });
});
