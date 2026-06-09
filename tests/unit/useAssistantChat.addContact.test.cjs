const assert = require("node:assert/strict");
const test = require("node:test");

const {
  handleAddContactCommand,
} = require("../../src/app/dashboard/lib/hooks/useAssistantChat.addContact.ts");

// The hook is essentially a structural transform from the parsed command
// into a confirmation card. The only branch is the title selection based
// on data.kind — a small but real business rule (kind drives downstream
// dispatch to customer.create vs supplier.create on confirmation).
function makeFakeCtx() {
  const captured = { confirmationRequest: null };
  return {
    captured,
    products: [],
    businessCurrency: "ARS",
    appendChatHistoryEntry: () => {},
    setInput: () => {},
    setLoadingParse: () => {},
    setAssistantReply: () => {},
    appendTransientReply: () => {},
    setAssistantConfirmationRequest: (req) => { captured.confirmationRequest = req; },
  };
}

test("handleAddContactCommand: customer kind produces a 'Confirmar nuevo cliente' card with action.kind=customer", async () => {
  const ctx = makeFakeCtx();
  const command = {
    matched: true,
    intent: "add_contact",
    data: {
      kind: "customer",
      name: "Juan Pérez",
      phone: "2615551234",
      email: null,
      taxId: null,
      contactName: null,
    },
  };
  const handled = await handleAddContactCommand(command, "nuevo cliente Juan Pérez", ctx);
  assert.equal(handled, true);
  assert.ok(ctx.captured.confirmationRequest);
  assert.equal(ctx.captured.confirmationRequest.title, "Confirmar nuevo cliente");
  assert.equal(ctx.captured.confirmationRequest.action.type, "add_contact");
  assert.equal(ctx.captured.confirmationRequest.action.kind, "customer");
  assert.equal(ctx.captured.confirmationRequest.action.name, "Juan Pérez");
  assert.equal(ctx.captured.confirmationRequest.action.phone, "2615551234");
});

test("handleAddContactCommand: supplier kind produces a 'Confirmar nuevo proveedor' card with action.kind=supplier", async () => {
  const ctx = makeFakeCtx();
  const command = {
    matched: true,
    intent: "add_contact",
    data: {
      kind: "supplier",
      name: "Aceros del Oeste",
      phone: null,
      email: "ventas@aceros.com",
      taxId: null,
      contactName: "Pedro",
    },
  };
  const handled = await handleAddContactCommand(command, "nuevo proveedor Aceros del Oeste", ctx);
  assert.equal(handled, true);
  assert.ok(ctx.captured.confirmationRequest);
  assert.equal(ctx.captured.confirmationRequest.title, "Confirmar nuevo proveedor");
  assert.equal(ctx.captured.confirmationRequest.action.kind, "supplier");
  assert.equal(ctx.captured.confirmationRequest.action.contactName, "Pedro");
  assert.equal(ctx.captured.confirmationRequest.action.email, "ventas@aceros.com");
});
