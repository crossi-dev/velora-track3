import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { buildActiveProductWhere } from "@/infrastructure/shared/product-sku";

export async function fetchProducts(businessId: string) {
  const products = await prisma.product.findMany({
    where: buildActiveProductWhere({ businessId }),
    select: {
      id: true,
      name: true,
      price: true,
      costPrice: true,
      sku: true,
      reorderThreshold: true,
      quantity: true,
      weightGrams: true,
    },
    orderBy: { name: "asc" },
    take: 1000,
  });

  return NextResponse.json(
    products.map((p) => ({
      id: p.id,
      name: p.name,
      price: Number(p.price),
      costPrice: p.costPrice !== null && p.costPrice !== undefined ? Number(p.costPrice) : null,
      sku: p.sku,
      stock: p.quantity,
      reorderThreshold: p.reorderThreshold ?? null,
      weightGrams: p.weightGrams ?? null,
    }))
  );
}
