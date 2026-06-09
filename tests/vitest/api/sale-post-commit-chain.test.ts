import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  chatMessageCreate,
  invoiceUpdateMany,
  sendWhatsAppMock,
  sendPushMock,
  handleFiscalMock,
  handlePaymentsMock,
  checkThresholdMock,
  evaluateConditionRulesMock,
  publishLowStockMock,
  buildEmployeeOnboardingMock,
  buildInvoicePdfMock,
  uploadPdfMock,
  cloudLogMock,
  reportErrorMock,
} = vi.hoisted(() => ({
  chatMessageCreate: vi.fn(),
  invoiceUpdateMany: vi.fn(),
  sendWhatsAppMock: vi.fn(),
  sendPushMock: vi.fn(),
  handleFiscalMock: vi.fn(),
  handlePaymentsMock: vi.fn(),
  checkThresholdMock: vi.fn(),
  evaluateConditionRulesMock: vi.fn(),
  publishLowStockMock: vi.fn(),
  buildEmployeeOnboardingMock: vi.fn(),
  buildInvoicePdfMock: vi.fn(),
  uploadPdfMock: vi.fn(),
  cloudLogMock: vi.fn(),
  reportErrorMock: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    chatMessage: { create: chatMessageCreate },
    invoice: { updateMany: invoiceUpdateMany },
  },
}));
vi.mock("@/lib/whatsapp", () => ({ sendWhatsAppMessage: sendWhatsAppMock }));
vi.mock("@/app/api/_lib/owner-push", () => ({ sendPushToOwner: sendPushMock }));
vi.mock("@/lib/cloud-logger", () => ({ cloudLog: cloudLogMock, reportError: reportErrorMock }));
vi.mock("@/app/api/agents/fiscal/jsonrpc/_lib/handle-fiscal-rpc", () => ({ handleFiscalRpc: handleFiscalMock }));
vi.mock("@/app/api/agents/payments/jsonrpc/_lib/handle-payments-rpc", () => ({ handlePaymentsRpcAsync: handlePaymentsMock }));
vi.mock("@/app/api/planner/_lib/planner-threshold", () => ({ checkThresholdCrossings: checkThresholdMock }));
vi.mock("@/app/api/planner/_lib/condition-stock-rules", () => ({ evaluateConditionBasedRules: evaluateConditionRulesMock }));
vi.mock("@/app/api/_lib/agent-event-publishers", () => ({ publishLowStockFromSale: publishLowStockMock }));
vi.mock("@/app/api/business-assistant/_lib/employee-welcome", () => ({ buildEmployeeOnboardingResponse: buildEmployeeOnboardingMock }));
vi.mock("@/app/api/invoices/[invoiceId]/pdf/build-invoice-pdf", () => ({ buildInvoicePdf: buildInvoicePdfMock }));
vi.mock("@/lib/r2", () => ({
  uploadPdfAndGetSignedUrl: uploadPdfMock,
  buildPdfR2Key: vi.fn(() => "test-key"),
}));
vi.mock("@/app/api/_lib/post-commit-failure-tracker", () => ({
  recordPostCommitFailure: vi.fn(),
}));
vi.mock("@/app/api/sales/create/_lib/transfer-payment-request-wa", () => ({
  sendTransferPaymentRequestWhatsApp: vi.fn().mockResolvedValue(undefined),
}));

import { firePostCommitActions } from "@/app/api/sales/create/sale-post-commit";
import type { InvoicePayload } from "@/infrastructure/shared/invoice-document";

const basePayload: InvoicePayload = {
  business: { name: "Test Biz", currency: "ARS", cuit: null, address: null },
  customer: { name: "Cliente Test", taxId: null, email: null, phone: null },
  sale: {
    id: "sale-001",
    invoiceNumber: "0001",
    date: "2026-05-08",
    items: [{ productName: "Tuerca", quantity: 1, unitPrice: 100, subtotal: 100 }],
    total: 100,
  },
};

const baseArgs = {
  businessId: "biz-1",
  // Non-null so writeSaleConfirmationToOwner pushes the owner (B3: owner-is-actor skips push).
  actorEmployeeId: "emp-001",
  saleId: "sale-001",
  invoiceId: "inv-001",
  whatsappPhone: null,
  paymentMethod: null,
  notifyLowStockWa: false,
};

async function settleFireAndForget() {
  // 1500ms delay del threshold path + buffer.
  await new Promise((r) => setTimeout(r, 1700));
}

describe("firePostCommitActions chain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    chatMessageCreate.mockResolvedValue({});
    invoiceUpdateMany.mockResolvedValue({ count: 1 });
    sendWhatsAppMock.mockResolvedValue(undefined);
    sendPushMock.mockResolvedValue({ attempted: 1, sent: 1, expired: 0, errors: [] });
    handleFiscalMock.mockResolvedValue({ result: "ok" });
    handlePaymentsMock.mockResolvedValue({ result: "ok" });
    checkThresholdMock.mockResolvedValue(0);
    evaluateConditionRulesMock.mockResolvedValue(undefined);
    publishLowStockMock.mockResolvedValue(undefined);
    buildEmployeeOnboardingMock.mockResolvedValue({ message: null, currentTask: null });
    buildInvoicePdfMock.mockResolvedValue(Buffer.from("pdf"));
    uploadPdfMock.mockResolvedValue(null);
  });

  it("customer con phone, sin taxId, sin lowStock → 1 chat + 1 push + 1 WA cliente", async () => {
    const payload: InvoicePayload = {
      ...basePayload,
      customer: { ...basePayload.customer, phone: "+5491155555555" },
    };
    firePostCommitActions({ ...baseArgs, invoicePayload: payload, lowStockAlerts: [] });
    await settleFireAndForget();

    expect(chatMessageCreate).toHaveBeenCalledTimes(1);
    expect(sendPushMock).toHaveBeenCalledTimes(1);
    expect(sendWhatsAppMock).toHaveBeenCalledTimes(1);
    expect(handleFiscalMock).not.toHaveBeenCalled();
    expect(handlePaymentsMock).not.toHaveBeenCalled();
    expect(checkThresholdMock).not.toHaveBeenCalled();
  });

  it("Consumidor Final (phone null) → 1 chat + 1 push + 0 WA + 0 fiscal/payments", async () => {
    firePostCommitActions({ ...baseArgs, invoicePayload: basePayload, lowStockAlerts: [] });
    await settleFireAndForget();

    expect(chatMessageCreate).toHaveBeenCalledTimes(1);
    expect(sendPushMock).toHaveBeenCalledTimes(1);
    expect(sendWhatsAppMock).not.toHaveBeenCalled();
    expect(handleFiscalMock).not.toHaveBeenCalled();
    expect(handlePaymentsMock).not.toHaveBeenCalled();
  });

  it("phone + taxId → 1 chat + 1 push + 1 WA + 1 fiscal + 1 payments", async () => {
    const payload: InvoicePayload = {
      ...basePayload,
      customer: { ...basePayload.customer, phone: "+5491155555555", taxId: "20-12345678-9" },
    };
    firePostCommitActions({ ...baseArgs, invoicePayload: payload, lowStockAlerts: [] });
    await settleFireAndForget();

    expect(chatMessageCreate).toHaveBeenCalledTimes(1);
    expect(sendPushMock).toHaveBeenCalledTimes(1);
    expect(sendWhatsAppMock).toHaveBeenCalledTimes(1);
    expect(handleFiscalMock).toHaveBeenCalledTimes(1);
    expect(handlePaymentsMock).toHaveBeenCalledTimes(1);
  });

  it("lowStockAlerts > 0 + ownerPhone → además owner WA alert + threshold path", async () => {
    firePostCommitActions({
      ...baseArgs,
      invoicePayload: basePayload,
      whatsappPhone: "+5491166666666",
      lowStockAlerts: [
        { productId: "p1", productName: "Tuerca", remainingUnits: 2, reorderThreshold: 5 },
      ],
    });
    await settleFireAndForget();

    expect(chatMessageCreate).toHaveBeenCalledTimes(1);
    expect(sendPushMock).toHaveBeenCalledTimes(1);
    expect(sendWhatsAppMock).toHaveBeenCalledTimes(1);
    expect(checkThresholdMock).toHaveBeenCalledTimes(1);
    expect(publishLowStockMock).toHaveBeenCalledTimes(1);
  });

  it("P2002 en sale-confirmation → 0 push (dedup contract preservado)", async () => {
    const p2002 = Object.assign(new Error("dup"), { code: "P2002" });
    chatMessageCreate.mockRejectedValueOnce(p2002);

    firePostCommitActions({ ...baseArgs, invoicePayload: basePayload, lowStockAlerts: [] });
    await settleFireAndForget();

    expect(sendPushMock).not.toHaveBeenCalled();
  });

  it("sendPushToOwner reject → chat-write OK, log SALE_CONFIRMATION_PUSH_FAILED emitido", async () => {
    sendPushMock.mockRejectedValueOnce(new Error("FCM down"));

    firePostCommitActions({ ...baseArgs, invoicePayload: basePayload, lowStockAlerts: [] });
    await settleFireAndForget();

    expect(chatMessageCreate).toHaveBeenCalledTimes(1);
    expect(sendPushMock).toHaveBeenCalledTimes(1);
    expect(cloudLogMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "SALE_CONFIRMATION_PUSH_FAILED" }),
    );
  });
});
