// E2E multi-tenant isolation — verifica que las APIs públicas (sin auth)
// no permiten enumerar IDs de otros tenants.

import { test, expect } from '@playwright/test';

const BASE_URL = process.env.BASE_URL || 'https://velora-000000000000.southamerica-east1.run.app';

test.describe(`Velora multi-tenant isolation @ ${BASE_URL}`, () => {
  test('/api/business sin auth → 401, no filtra datos', async () => {
    const res = await fetch(`${BASE_URL}/api/business`);
    expect([401, 403, 404, 405]).toContain(res.status);
    if (res.status < 400) {
      const text = await res.text();
      expect(text).not.toMatch(/businessId/);
    }
  });

  test('POST /api/sales/create sin auth → 401, no escribe', async () => {
    const res = await fetch(`${BASE_URL}/api/sales/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: [{ productId: 'fake_pid', quantity: 1, unitPrice: 100 }],
        total: 100,
      }),
    });
    expect([401, 403]).toContain(res.status);
  });

  test('POST /api/business-assistant sin auth → 401', async () => {
    const res = await fetch(`${BASE_URL}/api/business-assistant`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hola' }),
    });
    expect([401, 403]).toContain(res.status);
  });

  test('POST /api/employees/login con businessId fake no filtra existencia', async () => {
    const fakeId1 = '00000000000000000000000000000000';
    const fakeId2 = 'ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ';

    const [r1, r2] = await Promise.all([
      fetch(`${BASE_URL}/api/employees/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ businessId: fakeId1, name: 'x', pin: '0000' }),
      }),
      fetch(`${BASE_URL}/api/employees/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ businessId: fakeId2, name: 'x', pin: '0000' }),
      }),
    ]);

    expect(r1.status).toBe(r2.status);
    expect([400, 401, 404]).toContain(r1.status);
  });

  test('/.well-known/agent-card.json no expone businessIds privados', async () => {
    const res = await fetch(`${BASE_URL}/.well-known/agent-card.json`);
    expect(res.status).toBe(200);
    const card = await res.json();
    const json = JSON.stringify(card);
    expect(json).not.toMatch(/[a-f0-9]{32}/i);
    expect(json).not.toMatch(/@gmail\.com/i);
  });

  test('CRON_SECRET endpoints rebotan sin secret válido', async () => {
    const cleanupRes = await fetch(`${BASE_URL}/api/cleanup`);
    expect([401, 403]).toContain(cleanupRes.status);
  });
});
