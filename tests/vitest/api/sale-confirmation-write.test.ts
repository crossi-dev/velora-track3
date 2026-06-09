import { describe, it, expect, vi, beforeEach } from "vitest";

const { chatMessageCreate, sendPushMock, cloudLogMock } = vi.hoisted(() => ({
  chatMessageCreate: vi.fn(),
  sendPushMock: vi.fn(),
  cloudLogMock: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    chatMessage: { create: chatMessageCreate },
  },
}));

vi.mock("@/lib/cloud-logger", () => ({
  cloudLog: cloudLogMock,
  reportError: vi.fn(),
}));

vi.mock("@/app/api/_lib/owner-push", () => ({
  sendPushToOwner: sendPushMock,
}));

vi.mock("@/app/api/_lib/post-commit-failure-tracker", () => ({
  recordPostCommitFailure: vi.fn(),
}));

import { writeSaleConfirmationToOwner } from "@/app/api/sales/create/sale-confirmation-message";
import type { InvoicePayload } from "@/infrastructure/shared/invoice-document";

const payload: InvoicePayload = {
  business: { name: "Demo", currency: "ARS", cuit: null, address: null },
  customer: { name: "Pepe", taxId: null, email: null, phone: null },
  sale: {
    id: "s1",
    invoiceNumber: "0001",
    date: "2026-01-01",
    items: [{ productName: "tuerca", quantity: 1, unitPrice: 100, subtotal: 100 }],
    total: 100,
  },
};

describe("writeSaleConfirmationToOwner", () => {
  beforeEach(() => {
    chatMessageCreate.mockReset();
    sendPushMock.mockReset();
    cloudLogMock.mockReset();
  });

  it("calls sendPushToOwner after chatMessage.create succeeds", async () => {
    chatMessageCreate.mockResolvedValueOnce({});
    sendPushMock.mockResolvedValueOnce({ attempted: 1, sent: 1, expired: 0, errors: [] });

    // actorEmployeeId non-null → employee made the sale → push the owner
    await writeSaleConfirmationToOwner({ businessId: "biz1", saleId: "s1", invoicePayload: payload, actorEmployeeId: "emp1" });

    expect(chatMessageCreate).toHaveBeenCalledOnce();
    expect(sendPushMock).toHaveBeenCalledOnce();
    expect(sendPushMock).toHaveBeenCalledWith(
      "biz1",
      expect.objectContaining({
        title: expect.stringContaining("Venta"),
        url: "/dashboard",
      }),
    );
  });

  it("does NOT call sendPushToOwner on P2002 (already written before)", async () => {
    const err = Object.assign(new Error("unique violation"), { code: "P2002" });
    chatMessageCreate.mockRejectedValueOnce(err);

    await writeSaleConfirmationToOwner({ businessId: "biz1", saleId: "s1", invoicePayload: payload, actorEmployeeId: null });

    expect(sendPushMock).not.toHaveBeenCalled();
  });

  it("does NOT call sendPushToOwner if chatMessage.create fails non-P2002", async () => {
    chatMessageCreate.mockRejectedValueOnce(new Error("DB down"));

    await writeSaleConfirmationToOwner({ businessId: "biz1", saleId: "s1", invoicePayload: payload, actorEmployeeId: null });

    expect(sendPushMock).not.toHaveBeenCalled();
    expect(cloudLogMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "SALE_CONFIRMATION_WRITE_FAILED" }),
    );
  });

  it("does not throw if push fanout itself errors", async () => {
    chatMessageCreate.mockResolvedValueOnce({});
    sendPushMock.mockRejectedValueOnce(new Error("FCM down"));

    // actorEmployeeId non-null → push is attempted and can fail
    await expect(
      writeSaleConfirmationToOwner({ businessId: "biz1", saleId: "s1", invoicePayload: payload, actorEmployeeId: "emp1" }),
    ).resolves.toBeUndefined();
    expect(cloudLogMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "SALE_CONFIRMATION_PUSH_FAILED" }),
    );
  });

  it("body is truncated to 120 chars", async () => {
    chatMessageCreate.mockResolvedValueOnce({});
    sendPushMock.mockResolvedValueOnce({ attempted: 0, sent: 0, expired: 0, errors: [] });

    const longCustomerName = "a".repeat(200);
    const longPayload: InvoicePayload = {
      ...payload,
      customer: { ...payload.customer, name: longCustomerName },
    };
    // actorEmployeeId non-null so push is attempted and we can inspect its args
    await writeSaleConfirmationToOwner({ businessId: "biz1", saleId: "s2", invoicePayload: longPayload, actorEmployeeId: "emp1" });

    const callArgs = sendPushMock.mock.calls[0][1];
    expect(callArgs.body.length).toBeLessThanOrEqual(120);
  });
});
