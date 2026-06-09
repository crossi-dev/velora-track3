import { prisma } from "@/lib/prisma";
import type { CustomerRepositoryPort, CustomerRecord, CustomerCreateArgs, CustomerUpdateArgs, CustomerDeleteArgs } from "@/domain/ports/customer.repository.port";
import type { Tx } from "@/domain/ports/tx";
import { createCustomerInTransaction, updateCustomerInTransaction } from "@/infrastructure/shared/customer-mutations";
import { rewriteCustomerInvoiceSnapshotsInTransaction } from "@/infrastructure/shared/invoice-document";
import { toPrismaTx } from "@/infrastructure/persistence/tx-client";

export const prismaCustomerRepository: CustomerRepositoryPort = {
  async findById(businessId: string, customerId: string): Promise<CustomerRecord | null> {
    return prisma.customer.findFirst({
      where: { id: customerId, businessId },
      select: { id: true, name: true, phone: true, email: true, taxId: true, dni: true, ivaCondition: true, address: true, postalCode: true, city: true },
    });
  },

  async findByName(businessId: string, name: string): Promise<{ id: string } | null> {
    return prisma.customer.findFirst({
      where: { businessId, name: { equals: name, mode: "insensitive" } },
      select: { id: true },
    });
  },

  async hasHistory(businessId: string, customerId: string): Promise<{ invoiceCount: number; saleCount: number }> {
    const [invoiceCount, saleCount] = await Promise.all([
      prisma.invoice.count({ where: { customerId, businessId } }),
      prisma.sale.count({ where: { customerId, businessId } }),
    ]);
    return { invoiceCount, saleCount };
  },

  async createInTransaction(tx: Tx, args: CustomerCreateArgs): Promise<CustomerRecord> {
    const prismaTx = toPrismaTx(tx);
    return createCustomerInTransaction(prismaTx, {
      businessId: args.businessId,
      name: args.name,
      phone: args.phone,
      email: args.email,
      taxId: args.taxId,
      dni: args.dni,
      ivaCondition: args.ivaCondition,
      address: args.address,
      postalCode: args.postalCode,
      city: args.city,
    });
  },

  async updateInTransaction(tx: Tx, args: CustomerUpdateArgs): Promise<CustomerRecord> {
    const prismaTx = toPrismaTx(tx);
    return updateCustomerInTransaction(prismaTx, {
      businessId: args.businessId,
      customerId: args.customerId,
      name: args.name,
      phone: args.phone,
      email: args.email,
      taxId: args.taxId,
      dni: args.dni,
      ivaCondition: args.ivaCondition,
      address: args.address,
      postalCode: args.postalCode,
      city: args.city,
    });
  },

  async deleteInTransaction(tx: Tx, args: CustomerDeleteArgs): Promise<void> {
    const prismaTx = toPrismaTx(tx);
    await rewriteCustomerInvoiceSnapshotsInTransaction(prismaTx, {
      businessId: args.businessId,
      customerId: args.customerId,
      customer: args.snapshot,
    });
    await prismaTx.sale.updateMany({
      where: { businessId: args.businessId, customerId: args.customerId },
      data: { customerId: null },
    });
    await prismaTx.customer.deleteMany({ where: { id: args.customerId, businessId: args.businessId } });
  },
};
