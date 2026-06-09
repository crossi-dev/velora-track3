import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { checkRateLimit, logRouteError } from "@/app/api/_lib/route-helpers";
import { checkAiRateLimit } from "@/app/api/_lib/ai-rate-limit";
import { resolveActor } from "@/app/api/_lib/resolve-actor";
import { buildActiveProductWhere } from "@/infrastructure/shared/product-sku";
import { callParseSaleModel } from "./_lib/parse-sale-model-call";
import { resolveSales } from "./_lib/parse-sale-resolve";
import {
  MAX_ITEMS_PER_PARSED_SALE,
  MAX_PARSED_SALES,
  MAX_TOTAL_PARSED_ITEMS,
} from "./_lib/parse-sale-types";

export const maxDuration = 15;

export async function POST(req: NextRequest) {
  const rateLimited = checkRateLimit(req, "ai", 30, 60);
  if (rateLimited) return rateLimited;

  const actor = await resolveActor(req);
  if (!actor) return NextResponse.json({ code: "UNAUTHORIZED", message: "Authentication required." }, { status: 401 });
  if (actor.role !== "owner") {
    return NextResponse.json({ code: "FORBIDDEN", message: "Solo el dueño puede acceder a esto." }, { status: 403 });
  }

  const allowed = await checkAiRateLimit(actor.actorUserId);
  if (!allowed) {
    return NextResponse.json(
      { code: "DAILY_LIMIT_REACHED", message: "Daily request limit reached. Try again tomorrow." },
      { status: 429 }
    );
  }

  if (!actor.businessId) return NextResponse.json({ code: "BUSINESS_NOT_FOUND", message: "Business not found." }, { status: 404 });

  const businessId = actor.businessId;

  try {
    const {
      text: rawInputText,
      matchedProductId,
      matchedCustomerId,
      priceOverrides,
    } = await req.json() as {
      text?: string;
      matchedProductId?: string | null;
      matchedCustomerId?: string | null;
      priceOverrides?: Record<string, number | string> | null;
    };

    const inputText = typeof rawInputText === "string" ? rawInputText.slice(0, 1000) : rawInputText;

    if (!inputText) {
      return NextResponse.json({ code: "MISSING_TEXT", message: "Text is required." }, { status: 400 });
    }

    const modelResult = await callParseSaleModel(inputText);
    if (!modelResult.ok) {
      if (modelResult.kind === "empty_response") {
        return NextResponse.json({ code: "AI_EMPTY_RESPONSE", message: "The AI service returned an unexpected response." }, { status: 500 });
      }
      return NextResponse.json(
        { code: "PARSE_FAILED", message: "Could not understand the sale. Try something like: sold 3 products to a customer." },
        { status: 400 }
      );
    }

    const rawSales = modelResult.rawSales;

    if (!rawSales.length || !rawSales[0] || !Array.isArray(rawSales[0].items) || rawSales[0].items.length === 0) {
      return NextResponse.json(
        { code: "PARSE_FAILED", message: "Could not understand the sale. Try something like: sold 3 products to a customer." },
        { status: 400 }
      );
    }

    const totalParsedItems = rawSales.reduce((sum, sale) => {
      return sum + (Array.isArray(sale.items) ? sale.items.length : 0);
    }, 0);

    if (
      rawSales.length > MAX_PARSED_SALES ||
      totalParsedItems > MAX_TOTAL_PARSED_ITEMS ||
      rawSales.some((sale) => Array.isArray(sale.items) && sale.items.length > MAX_ITEMS_PER_PARSED_SALE)
    ) {
      return NextResponse.json(
        {
          code: "SALE_TOO_LARGE",
          message: "The sale is too large to process at once. Break it into smaller messages.",
        },
        { status: 400 }
      );
    }

    // SCALE NOTE (Fix #37): Se carga todo el catálogo de productos y clientes en memoria para
    // hacer fuzzy matching. Sin límite explícito aquí — depende del tamaño real del negocio.
    // Para negocios con < 500 productos y < 500 clientes esto es completamente aceptable.
    // Post-launch: si el catálogo supera 1000 items, migrar a búsqueda a nivel de DB usando
    // pg_trgm (extensión PostgreSQL para similitud de texto) o trigram indexes.
    // Ejemplo: SELECT * FROM products WHERE similarity(name, $query) > 0.3 ORDER BY similarity DESC.
    const [catalogProducts, catalogCustomers] = await Promise.all([
      prisma.product.findMany({
        where: buildActiveProductWhere({ businessId }),
        select: { id: true, name: true, price: true, sku: true },
        take: 500,
      }),
      prisma.customer.findMany({
        where: { businessId },
        select: { id: true, name: true, createdAt: true },
        orderBy: { createdAt: "desc" },
        take: 200,
      }),
    ]);

    const outcome = await resolveSales({
      rawSales,
      catalogProducts,
      catalogCustomers,
      matchedProductId,
      matchedCustomerId,
      priceOverrides,
    });

    if (outcome.kind === "error") {
      return NextResponse.json(outcome.body, { status: outcome.status });
    }

    const resolvedSales = outcome.sales;

    if (resolvedSales.length === 0) {
      return NextResponse.json(
        { code: "PARSE_FAILED", message: "Could not understand the sale. Try something like: sold 3 products to a customer." },
        { status: 400 }
      );
    }

    // Single sale: return flat object for backward compat with confirm UI
    if (resolvedSales.length === 1) {
      return NextResponse.json(resolvedSales[0]);
    }

    // Multiple sales: return array under `sales` key so client can batch-create
    return NextResponse.json({ sales: resolvedSales });
  } catch (error) {
    logRouteError("parse-sale", error);
    return NextResponse.json({ code: "PARSE_SALE_FAILED", message: "Error interno del servidor" }, { status: 500 });
  }
}
