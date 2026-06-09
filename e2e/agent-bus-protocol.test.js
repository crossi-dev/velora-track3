// E2E del protocolo A2A — verifica que el agent card declara los
// contratos y event types esperados. Es el "contrato externo" que un
// agente peer (Supervisor de Franquicia, otro Velora) consume para
// saber qué speakeamos.

import { test, expect } from '@playwright/test';

const BASE_URL = process.env.BASE_URL || 'https://velora-000000000000.southamerica-east1.run.app';

test.describe('Velora A2A agent card protocol', () => {
  let card;

  test.beforeAll(async () => {
    const res = await fetch(`${BASE_URL}/.well-known/agent-card.json`);
    expect(res.status).toBe(200);
    card = await res.json();
  });

  test('agent card declara skills array no vacío', () => {
    expect(Array.isArray(card.skills)).toBe(true);
    expect(card.skills.length).toBeGreaterThan(0);
  });

  test('agent card emite contrato velora.supervisor.notification v1', () => {
    expect(card.contracts).toBeDefined();
    const emits = Array.isArray(card.contracts.emits) ? card.contracts.emits : [];
    const notification = emits.find((c) => c.id === 'velora.supervisor.notification');
    expect(notification).toBeDefined();
    expect(notification.version).toBe('1.0.0');
  });

  test('agent card consume EmployeeEvent v1 con los 6 event types', () => {
    const consumes = Array.isArray(card.contracts.consumes) ? card.contracts.consumes : [];
    const employeeEvent = consumes.find((c) => c.id === 'velora.employee.event');
    expect(employeeEvent).toBeDefined();
    expect(employeeEvent.version).toBe('1.0.0');
    const expected = ['LOW_STOCK', 'UNUSUAL_DISCOUNT', 'SHIFT_START', 'SHIFT_END', 'CASH_AT_RISK', 'BULK_IMPORT_COMPLETED'];
    for (const type of expected) {
      expect(employeeEvent.eventTypes).toContain(type);
    }
  });
});
