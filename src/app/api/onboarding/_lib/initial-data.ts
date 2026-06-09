import { createProductInTransaction } from "@/infrastructure/shared/product-mutations";
import {
  createCustomerInTransaction,
  normalizeCustomerName,
} from "@/infrastructure/shared/customer-mutations";
import {
  createSupplierInTransaction,
  normalizeSupplierName,
  normalizeSupplierNullableText,
} from "@/app/api/_lib/supplier-mutations";
import type { CustomerInput, SupplierInput } from "./validators";
import type { Prisma } from "@prisma/client";

type TransactionClient = Prisma.TransactionClient;

export async function seedProducts(
  tx: TransactionClient,
  businessId: string,
  normalizedProducts: Array<{ name: string; price: number; stock: number }>
) {
  for (const p of normalizedProducts) {
    const initialStock = p.stock;
    const product = await createProductInTransaction(tx, {
      businessId,
      name: p.name,
      price: p.price,
    });

    if (initialStock > 0) {
      await tx.product.update({
        where: { id: product.id },
        data: { quantity: initialStock },
      });
    }

    if (initialStock > 0) {
      await tx.stockMovement.create({
        data: {
          businessId,
          productId: product.id,
          productName: product.name,
          quantityBefore: 0,
          quantityAfter: initialStock,
          delta: initialStock,
          reason: "manual",
        },
      });
    }
  }
}

export async function seedCustomers(
  tx: TransactionClient,
  businessId: string,
  customers: CustomerInput[]
) {
  const normalizedCustomersMap = new Map<
    string,
    { name: string; phone: string | null; email: string | null; taxId: string | null }
  >();

  for (const c of customers) {
    const name = normalizeCustomerName(c.name ?? "");
    if (!name) continue;

    normalizedCustomersMap.set(name, {
      name,
      phone: c.phone?.trim() || null,
      email: c.email?.trim() || null,
      taxId: c.taxId?.trim() || null,
    });
  }

  for (const customer of normalizedCustomersMap.values()) {
    await createCustomerInTransaction(tx, {
      businessId,
      name: customer.name,
      phone: customer.phone,
      email: customer.email,
      taxId: customer.taxId,
    });
  }
}

export async function seedSuppliers(
  tx: TransactionClient,
  businessId: string,
  suppliers: SupplierInput[]
) {
  const normalizedSuppliersMap = new Map<
    string,
    { name: string; phone: string | null; contactName: string | null; email: string | null }
  >();

  for (const s of suppliers) {
    const name = normalizeSupplierName(s.name ?? "");
    if (!name) continue;

    normalizedSuppliersMap.set(name, {
      name,
      phone: normalizeSupplierNullableText(s.phone),
      contactName: normalizeSupplierNullableText(s.contactName),
      email: normalizeSupplierNullableText(s.email),
    });
  }

  for (const supplier of normalizedSuppliersMap.values()) {
    await createSupplierInTransaction(tx, {
      businessId,
      name: supplier.name,
      phone: supplier.phone,
      contactName: supplier.contactName,
      email: supplier.email,
    });
  }
}
