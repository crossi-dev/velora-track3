import { prisma } from "@/lib/prisma";
import { buildActiveProductWhere } from "@/infrastructure/shared/product-sku";

export type ProductForDelete = {
  id: string;
  name: string;
  price: import("@prisma/client").Prisma.Decimal;
  sku: string | null;
  costPrice: import("@prisma/client").Prisma.Decimal | null;
  quantity: number;
  _count: { saleItems: number; stockMovements: number };
};

export async function fetchProductForDelete(
  id: string,
  businessId: string
): Promise<ProductForDelete | null> {
  return prisma.product.findFirst({
    where: buildActiveProductWhere({ id, businessId }),
    select: {
      id: true,
      name: true,
      price: true,
      sku: true,
      costPrice: true,
      quantity: true,
      _count: {
        select: {
          saleItems: true,
          stockMovements: true,
        },
      },
    },
  });
}

export function buildDeleteAuditPayload(product: ProductForDelete) {
  return {
    productId: product.id,
    name: product.name,
    price: Number(product.price),
    stock: product.quantity,
    sku: product.sku ?? null,
    costPrice: product.costPrice != null ? Number(product.costPrice) : null,
    deleteMode: "hard_deleted",
    saleItemsCount: product._count.saleItems,
    stockMovementsCount: product._count.stockMovements,
  };
}
