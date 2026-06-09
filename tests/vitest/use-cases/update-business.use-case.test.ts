import { describe, it, expect, vi, beforeEach } from "vitest";
import { updateBusinessUseCase } from "@/application/use-cases/update-business.use-case";
import type { BusinessRepositoryPort, BusinessForUpdate } from "@/domain/ports/business.repository.port";
import type { IdempotencyPort } from "@/domain/ports/idempotency.port";
import type { AuditPort } from "@/domain/ports/audit.port";
import type { TransactionPort } from "@/domain/ports/transaction.port";
import type { Tx } from "@/domain/ports/tx";

const mockTx = {} as Tx;

const existingBusiness: BusinessForUpdate = {
  id: "biz1", name: "Tienda Demo", type: "retail", email: null, cuit: null,
  address: null, phone: null, whatsappPhone: null, openingTime: null, closingTime: null,
  currency: "ARS", taxRate: 21, ivaCondition: null, puntoVenta: null, iibb: null,
  activityStart: null, allowNegativeStock: false, defaultCustomer: "Consumidor Final",
  allowSaleWithoutCustomer: true, openReceiptAfterSale: false,
  autoCreateProductOnStockLoad: false, suggestWhatsappAfterSale: false,
  lowStockThreshold: 5,
  alias: null,
  postalCode: null,
  courierPreference: null,
  notifyLowStockWa: false,
  // Step 1.5c: E.164 WhatsApp Business phone capture field.
  whatsappBusinessPhoneE164: null,
};

const mockBusiness: BusinessRepositoryPort = {
  findById: vi.fn(),
  findCurrency: vi.fn(),
  findByUserId: vi.fn(),
  findForUpdate: vi.fn(),
  updateInTransaction: vi.fn(),
};

const mockIdempotency: IdempotencyPort = {
  begin: vi.fn(),
  complete: vi.fn().mockResolvedValue(undefined),
  release: vi.fn().mockResolvedValue(undefined),
};

const mockAudit: AuditPort = {
  recordCriticalWrite: vi.fn().mockResolvedValue(true),
};

const mockTransaction: TransactionPort = {
  run: vi.fn(async (work) => work(mockTx)),
};

const ports = { business: mockBusiness, idempotency: mockIdempotency, audit: mockAudit, transaction: mockTransaction };
const useCase = updateBusinessUseCase(ports);

const baseInput = {
  businessId: "biz1",
  actorUserId: "user1",
  actorEmployeeId: null,
  body: { name: "Nueva Tienda", type: "food" },
  idempotencyKey: "key-biz",
  requestBody: {},
  actionMeta: { actionType: "business.update", routeScope: "business", resourceType: "Business" },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(mockIdempotency.complete).mockResolvedValue(undefined);
  vi.mocked(mockIdempotency.release).mockResolvedValue(undefined);
  vi.mocked(mockAudit.recordCriticalWrite).mockResolvedValue(true);
  vi.mocked(mockTransaction.run).mockImplementation(async (work) => work(mockTx));
});

describe("updateBusinessUseCase", () => {
  it("returns not_found when business missing", async () => {
    vi.mocked(mockBusiness.findForUpdate).mockResolvedValue(null);
    expect((await useCase.execute(baseInput)).outcome).toBe("not_found");
  });

  it("returns missing_name when name cleared", async () => {
    vi.mocked(mockBusiness.findForUpdate).mockResolvedValue(existingBusiness);
    const result = await useCase.execute({ ...baseInput, body: { name: "   " } });
    expect(result.outcome).toBe("missing_name");
  });

  it("does not block partial update when a blank type is submitted (keeps existing type)", async () => {
    // B2 fix: business type is enforced at onboarding/create, not on partial profile
    // updates. Submitting a blank type must NOT block saving other fields, and must
    // not clear an already-set type.
    vi.mocked(mockBusiness.findForUpdate).mockResolvedValue(existingBusiness);
    vi.mocked(mockIdempotency.begin).mockResolvedValue({ kind: "execute", recordId: "rec-type" });
    vi.mocked(mockBusiness.updateInTransaction).mockResolvedValue({ ...existingBusiness, name: "OK" });
    const result = await useCase.execute({ ...baseInput, body: { name: "OK", type: "" } });
    expect(result.outcome).toBe("updated");
  });

  it("returns invalid_tax_rate for negative rate", async () => {
    vi.mocked(mockBusiness.findForUpdate).mockResolvedValue(existingBusiness);
    const result = await useCase.execute({ ...baseInput, body: { taxRate: -1 } });
    expect(result.outcome).toBe("invalid_tax_rate");
  });

  it("returns invalid_cuit for malformed cuit", async () => {
    vi.mocked(mockBusiness.findForUpdate).mockResolvedValue(existingBusiness);
    const result = await useCase.execute({ ...baseInput, body: { cuit: "123" } });
    expect(result.outcome).toBe("invalid_cuit");
  });

  it("returns replayed on idempotency replay", async () => {
    vi.mocked(mockBusiness.findForUpdate).mockResolvedValue(existingBusiness);
    vi.mocked(mockIdempotency.begin).mockResolvedValue({ kind: "replay", status: 200, body: { ok: true } });
    expect((await useCase.execute(baseInput)).outcome).toBe("replayed");
  });

  it("updates business, completes idempotency, records audit", async () => {
    vi.mocked(mockBusiness.findForUpdate).mockResolvedValue(existingBusiness);
    vi.mocked(mockIdempotency.begin).mockResolvedValue({ kind: "execute", recordId: "rec1" });
    const updated = { ...existingBusiness, name: "Nueva Tienda", type: "food" };
    vi.mocked(mockBusiness.updateInTransaction).mockResolvedValue(updated);

    const result = await useCase.execute(baseInput);

    expect(result).toMatchObject({ outcome: "updated", business: expect.objectContaining({ name: "Nueva Tienda" }) });
    expect(mockIdempotency.complete).toHaveBeenCalledWith(mockTx, "rec1", 200, expect.anything());
    expect(mockAudit.recordCriticalWrite).toHaveBeenCalledOnce();
  });

  it("releases idempotency and rethrows on transaction error", async () => {
    vi.mocked(mockBusiness.findForUpdate).mockResolvedValue(existingBusiness);
    vi.mocked(mockIdempotency.begin).mockResolvedValue({ kind: "execute", recordId: "rec2" });
    vi.mocked(mockTransaction.run).mockRejectedValue(new Error("tx failed"));

    await expect(useCase.execute(baseInput)).rejects.toThrow("tx failed");
    expect(mockIdempotency.release).toHaveBeenCalledWith("rec2");
  });
});
