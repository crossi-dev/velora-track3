import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolveActor } from "@/app/api/_lib/resolve-actor";
import { checkRateLimit, bypassIfTester } from "@/app/api/_lib/route-helpers";
import { buildActiveProductWhere } from "@/infrastructure/shared/product-sku";

export async function GET(req: NextRequest) {
  const actor = await resolveActor(req);
  // SEC-NOTE: owner role is explicitly rejected here — this endpoint is
  // employee-only context for the Companion chat. Owners access data via
  // /api/business and other owner-scoped routes. All queries below are
  // scoped to actor.businessId which comes from the verified employee session,
  // never from user input.
  if (!actor || actor.role === "owner") {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  const rateLimited = checkRateLimit(req, undefined, undefined, undefined, bypassIfTester(actor));
  if (rateLimited) return rateLimited;

  const [business, products, customers, employeeRow, cashMovementsRaw, cashTotalAgg, salesRaw] =
    await Promise.all([
      prisma.business.findUnique({
        where: { id: actor.businessId },
        select: {
          id: true,
          name: true,
          type: true,
          cuit: true,
          address: true,
          phone: true,
          email: true,
          whatsappPhone: true,
          openingTime: true,
          closingTime: true,
          currency: true,
          taxRate: true,
          workerCount: true,
          openingCash: true,
          createdAt: true,
        },
      }),
      prisma.product.findMany({
        where: buildActiveProductWhere({ businessId: actor.businessId }),
        select: {
          id: true,
          name: true,
          price: true,
          sku: true,
          quantity: true,
        },
        orderBy: { name: "asc" },
        take: 500,
      }),
      prisma.customer.findMany({
        where: { businessId: actor.businessId },
        select: { id: true, name: true, phone: true },
        orderBy: { name: "asc" },
        take: 500,
      }),
      actor.actorEmployeeId
        ? prisma.employee.findFirst({
            where: { id: actor.actorEmployeeId, businessId: actor.businessId },
            select: { name: true },
          })
        : Promise.resolve(null),
      prisma.cashMovement.findMany({
        where: { businessId: actor.businessId },
        orderBy: { date: "desc" },
        take: 20,
        select: { id: true, saleId: true, type: true, description: true, amount: true, date: true },
      }),
      prisma.cashMovement.aggregate({
        where: { businessId: actor.businessId },
        _sum: { amount: true },
      }),
      prisma.sale.findMany({
        where: { businessId: actor.businessId },
        orderBy: { date: "desc" },
        take: 100,
        select: {
          id: true,
          date: true,
          totalAmount: true,
          status: true,
          customer: { select: { id: true, name: true } },
          saleItems: {
            select: {
              quantity: true,
              unitPrice: true,
              unitCost: true,
              product: { select: { id: true, name: true } },
            },
          },
        },
      }),
    ]);

  if (!business) {
    return NextResponse.json({ error: "Negocio no encontrado" }, { status: 404 });
  }

  return NextResponse.json({
    employee: { name: employeeRow?.name ?? "" },
    business: {
      ...business,
      taxRate: Number(business.taxRate),
      openingCash: Number(business.openingCash),
      createdAt: business.createdAt.toISOString(),
    },
    products: products.map((p) => ({
      id: p.id,
      name: p.name,
      price: Number(p.price),
      sku: p.sku ?? null,
      stock: p.quantity,
      costPrice: null,
    })),
    customers: customers.map((c) => ({
      id: c.id,
      name: c.name,
      phone: c.phone ?? null,
      email: null,
      taxId: null,
    })),
    cashMovements: cashMovementsRaw.map((m) => ({
      id: m.id,
      saleId: m.saleId ?? null,
      type: m.type,
      description: m.description,
      amount: Number(m.amount),
      date: m.date,
    })),
    cashTotal: Number(cashTotalAgg._sum.amount ?? 0),
    sales: salesRaw.map((s) => ({
      id: s.id,
      date: s.date,
      totalAmount: Number(s.totalAmount),
      status: s.status,
      customer: s.customer ?? null,
      items: s.saleItems.map((item) => ({
        quantity: item.quantity,
        unitPrice: Number(item.unitPrice),
        unitCost: item.unitCost != null ? Number(item.unitCost) : null,
        product: item.product,
      })),
    })),
  });
}
