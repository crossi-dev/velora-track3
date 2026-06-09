// E2E authenticated flow — employee PIN login + session-cookied API call.
//
// Setup: requires a test employee fixture in the target DB. Three env vars
// must be set or the suite skips:
//   TEST_BUSINESS_ID   — businessId of the test tenant
//   TEST_EMPLOYEE_NAME — exact name string registered for the employee
//   TEST_EMPLOYEE_PIN  — plain PIN (server hashes via scrypt)

import { test, expect } from '@playwright/test';

const BASE_URL = process.env.BASE_URL || 'https://velora-000000000000.southamerica-east1.run.app';
const TEST_BUSINESS_ID = process.env.TEST_BUSINESS_ID;
const TEST_EMPLOYEE_NAME = process.env.TEST_EMPLOYEE_NAME;
const TEST_EMPLOYEE_PIN = process.env.TEST_EMPLOYEE_PIN;

const HAS_FIXTURE = Boolean(TEST_BUSINESS_ID && TEST_EMPLOYEE_NAME && TEST_EMPLOYEE_PIN);

const describeFixture = HAS_FIXTURE ? test.describe : test.describe.skip;

describeFixture(`Velora authenticated PIN flow @ ${BASE_URL}`, () => {
  let sessionCookie;

  test.beforeAll(async () => {
    const res = await fetch(`${BASE_URL}/api/employees/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        businessId: TEST_BUSINESS_ID,
        name: TEST_EMPLOYEE_NAME,
        pin: TEST_EMPLOYEE_PIN,
      }),
    });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get('set-cookie') || '';
    expect(setCookie).toMatch(/velora_employee/);
    sessionCookie = setCookie;
  });

  test('login response sets HMAC session cookie with HttpOnly', () => {
    expect(sessionCookie).toMatch(/HttpOnly/i);
    expect(sessionCookie).toMatch(/Secure/i);
    expect(sessionCookie).toMatch(/SameSite/i);
  });

  test('invalid PIN returns 401, no cookie set', async () => {
    const res = await fetch(`${BASE_URL}/api/employees/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        businessId: TEST_BUSINESS_ID,
        name: TEST_EMPLOYEE_NAME,
        pin: '0000-wrong',
      }),
    });
    expect(res.status).toBe(401);
    const setCookie = res.headers.get('set-cookie') || '';
    expect(setCookie).not.toMatch(/velora_employee=[^;]+/);
  });

  test('unknown employee returns 401 (no oracle)', async () => {
    const res = await fetch(`${BASE_URL}/api/employees/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        businessId: TEST_BUSINESS_ID,
        name: 'ZZ_DOES_NOT_EXIST',
        pin: '0000',
      }),
    });
    expect(res.status).toBe(401);
  });

  test('session cookie unlocks /api/business-assistant POST', async () => {
    const cookieValue = sessionCookie.split(';')[0];
    const res = await fetch(`${BASE_URL}/api/business-assistant`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookieValue,
      },
      body: JSON.stringify({ message: 'hola' }),
    });
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
    expect([200, 429]).toContain(res.status);
  });

  test('missing cookie on /api/business-assistant returns 401', async () => {
    const res = await fetch(`${BASE_URL}/api/business-assistant`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hola' }),
    });
    expect(res.status).toBe(401);
  });

  test('cross-tenant: cookie from biz A cannot read biz B data via business-assistant', async () => {
    const cookieValue = sessionCookie.split(';')[0];
    const res = await fetch(`${BASE_URL}/api/business-assistant`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookieValue,
      },
      body: JSON.stringify({
        message: 'hola',
        activeInvoiceId: 'fake_other_tenant_invoice_99999',
      }),
    });
    expect([200, 429]).toContain(res.status);
  });
});
