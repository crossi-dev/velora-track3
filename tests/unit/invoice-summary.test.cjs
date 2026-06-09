const assert = require("node:assert/strict");
const test = require("node:test");

const {
  getInvoicesForClient,
  sumInvoiceTotals,
} = require("../../src/app/dashboard/lib/invoice-summary.ts");

test("getInvoicesForClient matchea por telefono cuando existe y por nombre cuando falta", () => {
  const client = { id: "c1", name: "Juan Pérez", phone: "+54 9 11 5555-1111" };
  const invoices = [
    {
      id: "i1",
      totalAmount: 1000,
      payload: { customer: { name: "Otro", phone: "5491155551111" } },
    },
    {
      id: "i2",
      totalAmount: 500,
      payload: { customer: { name: "Juan Pérez", phone: null } },
    },
  ];

  const result = getInvoicesForClient(client, invoices);

  assert.equal(result.length, 2);
  assert.equal(result[0].id, "i1");
  assert.equal(result[1].id, "i2");
});

test("getInvoicesForClient usa nombre cuando falta telefono", () => {
  const client = { id: "c1", name: "Juan Pérez", phone: null };
  const invoices = [
    {
      id: "i1",
      totalAmount: 1000,
      payload: { customer: { name: "Juan Pérez", phone: null } },
    },
    {
      id: "i2",
      totalAmount: 500,
      payload: { customer: { name: "María", phone: null } },
    },
  ];

  const result = getInvoicesForClient(client, invoices);

  assert.equal(result.length, 1);
  assert.equal(result[0].id, "i1");
});

test("sumInvoiceTotals suma todas las facturas sin filtrar por estado", () => {
  const total = sumInvoiceTotals([
    { totalAmount: 1000 },
    { totalAmount: 500.5 },
    { totalAmount: 249.5 },
  ]);

  assert.equal(total, 1750);
});
