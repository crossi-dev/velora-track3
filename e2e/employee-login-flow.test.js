// E2E — employee login + dashboard redirect regression.
//
// Cubre el bug donde el empleado terminaba en la landing después de
// loguearse correctamente (window.location.href fix en useEmployeeLogin.ts).
//
// Tests 1 y 2 corren siempre. Test 3 requiere:
//   TEST_BUSINESS_ID, TEST_EMPLOYEE_NAME, TEST_EMPLOYEE_PIN (env vars).
// Sin esas vars, el test 3 se skipea pero los otros dos siguen corriendo.

import { test, expect } from '@playwright/test';

const BASE_URL = process.env.BASE_URL || 'https://www.somosvelora.com';

test.describe(`Employee login flow @ ${BASE_URL}`, () => {
  test('POST /api/employees/login con credenciales inválidas → 401', async () => {
    const res = await fetch(`${BASE_URL}/api/employees/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ businessId: 'fake-biz', name: 'Nadie', pin: '9999' }),
    });
    expect(res.status).toBe(401);
  });

  test('/dashboard sin sesión redirige a /', async ({ page }) => {
    await page.context().clearCookies();
    await page.goto(`${BASE_URL}/dashboard`, { waitUntil: 'networkidle' });
    const finalUrl = page.url();
    // Middleware debe redirigir a la landing (/) o a /employee-login — nunca al dashboard.
    expect(finalUrl).not.toMatch(/\/dashboard/);
  });

  test('login exitoso → /dashboard accesible (no landing)', async ({ page }) => {
    const { TEST_BUSINESS_ID, TEST_EMPLOYEE_NAME, TEST_EMPLOYEE_PIN } = process.env;
    test.skip(!TEST_BUSINESS_ID || !TEST_EMPLOYEE_NAME || !TEST_EMPLOYEE_PIN,
      'Configurá TEST_BUSINESS_ID, TEST_EMPLOYEE_NAME, TEST_EMPLOYEE_PIN');

    await page.context().clearCookies();

    // Login desde el browser para que la cookie httpOnly quede en el browser jar.
    const loginStatus = await page.evaluate(
      async ({ url, businessId, name, pin }) => {
        const r = await fetch(`${url}/api/employees/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ businessId, name, pin }),
          credentials: 'include',
        });
        return r.status;
      },
      { url: BASE_URL, businessId: TEST_BUSINESS_ID, name: TEST_EMPLOYEE_NAME, pin: TEST_EMPLOYEE_PIN },
    );

    expect(loginStatus).toBe(200);

    // Navegar al dashboard — debe llegar, no ser redirigido a /.
    await page.goto(`${BASE_URL}/dashboard`, { waitUntil: 'networkidle' });
    const finalUrl = page.url();

    expect(finalUrl).toContain('/dashboard');
    expect(finalUrl).not.toBe(`${BASE_URL}/`);
  });

  test('POST /api/employees/login sin body → 400', async () => {
    const res = await fetch(`${BASE_URL}/api/employees/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});
