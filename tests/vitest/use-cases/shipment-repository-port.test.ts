// TDD RED → GREEN: ShipmentRepositoryPort Prisma adapter
// Package 1, Task T1 — pure port/adapter, no wiring into callers.
// Verifies: upsertAndreaniShipment calls prisma.andreaniShipment.upsert
// with correct create/update fields and tenant isolation.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";

function makeMockPrisma() {
  return {
    andreaniShipment: {
      upsert: vi.fn(),
    },
  } as unknown as PrismaClient;
}

import { makePrismaShipmentRepository } from "@/infrastructure/persistence/prisma-shipment.repository";

describe("PrismaShipmentRepository", () => {
  let mockPrisma: ReturnType<typeof makeMockPrisma>;
  let repo: ReturnType<typeof makePrismaShipmentRepository>;

  const estimatedDelivery = new Date("2026-06-10T00:00:00Z");

  const baseArgs = {
    saleId: "sale_1",
    businessId: "biz_1",
    trackingNumber: "AND-12345",
    service: "domicilio",
    labelPdfPath: "pdfs/label/biz_1/sale_1/AND-12345.pdf",
    estimatedDelivery,
  };

  beforeEach(() => {
    mockPrisma = makeMockPrisma();
    repo = makePrismaShipmentRepository(mockPrisma);
    vi.clearAllMocks();
    vi.mocked(mockPrisma.andreaniShipment.upsert).mockResolvedValue({} as never);
  });

  describe("upsertAndreaniShipment", () => {
    it("calls andreaniShipment.upsert with where: { saleId }", async () => {
      await repo.upsertAndreaniShipment(baseArgs);

      const call = vi.mocked(mockPrisma.andreaniShipment.upsert).mock.calls[0]?.[0];
      expect(call).toBeDefined();
      expect(call?.where).toEqual({ saleId: "sale_1" });
    });

    it("create block includes businessId, saleId, trackingNumber, service, status: 'created'", async () => {
      await repo.upsertAndreaniShipment(baseArgs);

      const call = vi.mocked(mockPrisma.andreaniShipment.upsert).mock.calls[0]?.[0];
      expect(call?.create).toMatchObject({
        businessId: "biz_1",
        saleId: "sale_1",
        trackingNumber: "AND-12345",
        service: "domicilio",
        status: "created",
        labelPdfPath: "pdfs/label/biz_1/sale_1/AND-12345.pdf",
        estimatedDelivery,
        events: [],
      });
    });

    it("update block includes trackingNumber, service, status but NOT businessId", async () => {
      await repo.upsertAndreaniShipment(baseArgs);

      const call = vi.mocked(mockPrisma.andreaniShipment.upsert).mock.calls[0]?.[0];
      expect(call?.update).toMatchObject({
        trackingNumber: "AND-12345",
        service: "domicilio",
        status: "created",
        labelPdfPath: "pdfs/label/biz_1/sale_1/AND-12345.pdf",
        estimatedDelivery,
      });
      // businessId must NOT be in the update block — cannot change tenant ownership
      expect(call?.update).not.toHaveProperty("businessId");
    });

    it("handles null labelPdfPath", async () => {
      await repo.upsertAndreaniShipment({ ...baseArgs, labelPdfPath: null });

      const call = vi.mocked(mockPrisma.andreaniShipment.upsert).mock.calls[0]?.[0];
      expect(call?.create).toMatchObject({ labelPdfPath: null });
      expect(call?.update).toMatchObject({ labelPdfPath: null });
    });

    it("resolves to void (no return value used)", async () => {
      const result = await repo.upsertAndreaniShipment(baseArgs);
      expect(result).toBeUndefined();
    });
  });
});
