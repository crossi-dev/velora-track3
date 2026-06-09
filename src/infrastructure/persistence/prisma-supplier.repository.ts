import { prisma } from "@/lib/prisma";
import type { SupplierRepositoryPort, SupplierRecord, SupplierCreateArgs, SupplierUpdateArgs, SupplierDeleteArgs } from "@/domain/ports/supplier.repository.port";
import type { Tx } from "@/domain/ports/tx";
import { findSupplierByBusinessAndName } from "@/app/api/_lib/supplier-resolution";
import { normalizeNullableInput } from "@/lib/normalize";
import { toPrismaTx } from "@/infrastructure/persistence/tx-client";

const MAX_FIELD_LENGTH = 500;

type PurchaseRequestPayload = {
  supplier?: { name?: string | null; phone?: string | null; email?: string | null; contactName?: string | null };
  [key: string]: unknown;
};

function normalizeLeadTime(value: number | null | undefined): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 3;
}

export const prismaSupplierRepository: SupplierRepositoryPort = {
  async findById(businessId: string, supplierId: string): Promise<SupplierRecord | null> {
    const row = await prisma.supplier.findFirst({
      where: { id: supplierId, businessId },
      select: { id: true, name: true, phone: true, email: true, contactName: true, leadTimeDays: true },
    });
    if (!row) return null;
    return { ...row, leadTimeDays: row.leadTimeDays ?? 3 };
  },

  async createInTransaction(tx: Tx, args: SupplierCreateArgs): Promise<SupplierRecord> {
    const prismaTx = toPrismaTx(tx);
    const existing = await findSupplierByBusinessAndName(prismaTx, args.businessId, args.name, { allowContainsMatch: false });
    if (existing) throw new Error("SUPPLIER_ALREADY_EXISTS");

    const row = await prismaTx.supplier.create({
      data: {
        businessId: args.businessId,
        name: args.name,
        phone: normalizeNullableInput(args.phone, MAX_FIELD_LENGTH),
        contactName: normalizeNullableInput(args.contactName, MAX_FIELD_LENGTH),
        email: normalizeNullableInput(args.email, MAX_FIELD_LENGTH),
        leadTimeDays: normalizeLeadTime(args.leadTimeDays),
      },
      select: { id: true, name: true, phone: true, contactName: true, email: true, leadTimeDays: true },
    });
    return { ...row, leadTimeDays: row.leadTimeDays ?? 3 };
  },

  async updateInTransaction(tx: Tx, args: SupplierUpdateArgs): Promise<void> {
    const prismaTx = toPrismaTx(tx);

    if (args.name !== undefined) {
      const duplicate = await findSupplierByBusinessAndName(prismaTx, args.businessId, args.name, { allowContainsMatch: false });
      if (duplicate && duplicate.id !== args.supplierId) throw new Error("SUPPLIER_ALREADY_EXISTS");
    }

    const updateData: {
      name?: string;
      phone?: string | null;
      email?: string | null;
      contactName?: string | null;
      leadTimeDays?: number;
    } = {};

    if (args.name !== undefined) updateData.name = args.name;
    if (args.phone !== undefined) updateData.phone = normalizeNullableInput(args.phone, MAX_FIELD_LENGTH);
    if (args.email !== undefined) updateData.email = normalizeNullableInput(args.email, MAX_FIELD_LENGTH);
    if (args.contactName !== undefined) updateData.contactName = normalizeNullableInput(args.contactName, MAX_FIELD_LENGTH);
    if (args.leadTimeDays !== undefined) updateData.leadTimeDays = normalizeLeadTime(args.leadTimeDays);

    const updated = await prismaTx.supplier.updateMany({
      where: { id: args.supplierId, businessId: args.businessId },
      data: updateData,
    });
    if (!updated.count) throw new Error("SUPPLIER_NOT_FOUND");
  },

  async deleteInTransaction(tx: Tx, args: SupplierDeleteArgs): Promise<void> {
    const prismaTx = toPrismaTx(tx);
    const { businessId, supplierId, snapshot } = args;

    const purchaseRequests = await prismaTx.purchaseRequest.findMany({
      where: { businessId, supplierId },
      select: { id: true, payloadJson: true },
    });

    for (const request of purchaseRequests) {
      try {
        const payload = JSON.parse(request.payloadJson) as PurchaseRequestPayload;
        const nextPayload: PurchaseRequestPayload = {
          ...payload,
          supplier: { ...(payload.supplier ?? {}), name: snapshot.name, phone: snapshot.phone, email: snapshot.email, contactName: snapshot.contactName },
        };
        // Defense-in-depth tenant guard: scope write by both id+businessId to prevent
      // cross-tenant payload mutation if request.id leaked through the findMany above.
      await prismaTx.purchaseRequest.updateMany({ where: { id: request.id, businessId }, data: { payloadJson: JSON.stringify(nextPayload) } });
      } catch { /* corrupt payload — skip */ }
    }

    await prismaTx.purchaseRequest.updateMany({ where: { businessId, supplierId }, data: { supplierId: null } });
    // Defense-in-depth tenant guard: deleteMany scoped by both id+businessId
    // prevents cross-tenant deletion if a stale supplierId leaks through
    // upstream validation. Returns count, not row — we accept count==0 as
    // already-deleted (concurrent caller) rather than throwing.
    await prismaTx.supplier.deleteMany({ where: { id: supplierId, businessId } });
  },
};
