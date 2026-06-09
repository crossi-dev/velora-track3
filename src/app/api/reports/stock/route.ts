import { NextRequest, NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { prisma } from "@/lib/prisma";
import {
  checkRateLimitExpensive,
  logRouteError,
  unauthorized,
} from "@/app/api/_lib/route-helpers";
import { resolveActor, requireRole } from "@/app/api/_lib/resolve-actor";
import { buildActiveProductWhere } from "@/infrastructure/shared/product-sku";

// GET /api/reports/stock  — snapshot del momento
export async function GET(req: NextRequest) {
  const rateLimited = checkRateLimitExpensive(req);
  if (rateLimited) return rateLimited;

  const ctx = await resolveActor(req);
  if (!ctx) return unauthorized();
  const forbidden = requireRole(ctx, ["owner"]);
  if (forbidden) return forbidden;
  const { businessId } = ctx;

  try {
    const products = await prisma.product.findMany({
      where: buildActiveProductWhere({ businessId }),
      select: {
        id: true,
        name: true,
        price: true,
        costPrice: true,
        quantity: true,
      },
      orderBy: { name: "asc" },
      take: 2000,
    });

    // Last restock date per product (delta > 0, reason = purchase/restock)
    const productIds = products.map((p) => p.id);
    const restocks = await prisma.stockMovement.findMany({
      where: {
        businessId,
        productId: { in: productIds },
        delta: { gt: 0 },
        reason: { in: ["purchase", "restock", "stock_load"] },
      },
      select: { productId: true, createdAt: true },
      orderBy: { createdAt: "desc" },
    });

    // Last sale date per product
    const lastSales = await prisma.saleItem.findMany({
      where: { productId: { in: productIds }, sale: { businessId } },
      select: { productId: true, sale: { select: { date: true } } },
      orderBy: { sale: { date: "desc" } },
      distinct: ["productId"],
    });

    const lastRestockMap = new Map<string, Date>();
    for (const r of restocks) {
      if (r.productId && !lastRestockMap.has(r.productId)) {
        lastRestockMap.set(r.productId, r.createdAt);
      }
    }
    const lastSaleMap = new Map<string, Date>();
    for (const s of lastSales) {
      if (s.productId && !lastSaleMap.has(s.productId)) {
        lastSaleMap.set(s.productId, s.sale.date);
      }
    }

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Stock");

    sheet.columns = [
      { header: "Producto", key: "producto", width: 34 },
      { header: "Stock actual", key: "stock", width: 12 },
      { header: "Costo unit.", key: "costo", width: 14 },
      { header: "Precio venta", key: "precio", width: 14 },
      { header: "Valor stock total", key: "valor_total", width: 18 },
      { header: "Última reposición", key: "ultima_reposicion", width: 20 },
      { header: "Última venta", key: "ultima_venta", width: 18 },
    ];

    styleHeader(sheet);

    for (const p of products) {
      const stock = p.quantity;
      const costo = Number(p.costPrice ?? 0);
      const precio = Number(p.price);
      const valorTotal = stock * (costo > 0 ? costo : precio);
      const ultimaReposicion = lastRestockMap.get(p.id);
      const ultimaVenta = lastSaleMap.get(p.id);

      sheet.addRow({
        producto: p.name,
        stock,
        costo: costo > 0 ? costo : "—",
        precio,
        valor_total: valorTotal,
        ultima_reposicion: ultimaReposicion ? ultimaReposicion.toLocaleDateString("es-AR") : "—",
        ultima_venta: ultimaVenta ? ultimaVenta.toLocaleDateString("es-AR") : "—",
      });
    }

    sheet.eachRow((row, i) => {
      if (i === 1) return;
      ["costo", "precio", "valor_total"].forEach((key) => {
        const col = sheet.columns.find((c) => c.key === key);
        if (!col || col.number == null) return;
        const cell = row.getCell(col.number);
        if (typeof cell.value === "number") cell.numFmt = "#,##0.00";
      });
    });

    const buffer = await workbook.xlsx.writeBuffer();
    const now = new Date();
    const filename = `stock-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}.xlsx`;

    return new NextResponse(buffer, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    logRouteError("reports/stock", error);
    return NextResponse.json({ code: "INTERNAL_ERROR", message: "No se pudo generar el reporte de stock." }, { status: 500 });
  }
}

function styleHeader(sheet: ExcelJS.Worksheet) {
  const header = sheet.getRow(1);
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1A56DB" } };
  header.alignment = { vertical: "middle" };
}
