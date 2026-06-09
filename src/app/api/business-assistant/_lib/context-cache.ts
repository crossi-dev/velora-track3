import { prisma } from "@/lib/prisma";
import { buildActiveProductWhere } from "@/infrastructure/shared/product-sku";

const STATIC_TTL_MS = 90_000; // 90 s — safe for demo; invalidated on mutations

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

class TtlStore<T> {
  private readonly map = new Map<string, CacheEntry<T>>();

  get(key: string): T | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) { this.map.delete(key); return undefined; }
    return entry.value;
  }

  set(key: string, value: T, ttlMs = STATIC_TTL_MS): void {
    this.map.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  delete(key: string): void { this.map.delete(key); }
}

function isMissingTableError(error: unknown, tableName: string) {
  if (!error || typeof error !== "object") return false;
  const r = error as Record<string, unknown>;
  const code = typeof r.code === "string" ? r.code : "";
  const message = error instanceof Error ? error.message : String(r.message ?? "");
  return code === "P2021" && message.includes(tableName);
}

type RawStaticBusinessContext = Awaited<ReturnType<typeof fetchStaticBusinessContext>>;

export type StaticBusinessContext = Omit<RawStaticBusinessContext, "business"> & {
  business: NonNullable<RawStaticBusinessContext["business"]>;
};

async function fetchStaticBusinessContext(businessId: string) {
  // Prisma v6 does NOT support AbortSignal on query methods (open issue
  // prisma/prisma#15594 since 2022). The singleflight timeout in
  // loadStaticBusinessContext below uses Promise.race; if it fires, the
  // JS layer stops waiting but the underlying Postgres query keeps running
  // until it completes on its own. The connection pool size is the bound.
  const [business, invoicesRaw, purchaseRequestsRaw, fullProductCatalog] = await Promise.all([
    prisma.business.findUnique({
      where: { id: businessId },
      select: {
        name: true, type: true, currency: true,
        products: {
          where: buildActiveProductWhere(),
          select: { id: true, name: true, sku: true, price: true, quantity: true },
          orderBy: { name: "asc" }, take: 500,
        },
        customers: { select: { id: true, name: true }, orderBy: { name: "asc" }, take: 200 },
        suppliers: {
          select: { id: true, name: true, phone: true, email: true, contactName: true },
          orderBy: { name: "asc" }, take: 200,
        },
        sales: {
          select: {
            id: true, date: true, totalAmount: true,
            customer: { select: { name: true } },
            saleItems: { select: { quantity: true, product: { select: { name: true } } } },
          },
          orderBy: { date: "desc" }, take: 20,
        },
      },
    }),
    prisma.invoice.findMany({
      where: { businessId }, orderBy: { issuedAt: "desc" }, take: 40,
      select: { id: true, saleId: true, invoiceNumber: true, status: true, issuedAt: true, customerId: true, payloadJson: true },
    }),
    prisma.purchaseRequest.findMany({
      where: { businessId }, orderBy: { issuedAt: "desc" }, take: 40,
      select: { id: true, supplierId: true, requestNumber: true, issuedAt: true, currency: true, totalAmount: true, payloadJson: true },
    }).catch((err: unknown) => {
      if (isMissingTableError(err, "PurchaseRequest")) return [];
      throw err;
    }),
    prisma.product.findMany({
      where: buildActiveProductWhere({ businessId }),
      select: { id: true, name: true, sku: true, price: true },
      orderBy: { name: "asc" }, take: 500,
    }),
  ]);

  const topProductSales = await prisma.saleItem.groupBy({
    by: ["productId"],
    where: { sale: { businessId } },
    _sum: { quantity: true },
    orderBy: { _sum: { quantity: "desc" } },
    take: 10,
  }).catch(() => []);

  const topProductNameRows = topProductSales.length
    ? await prisma.product.findMany({
        where: {
          businessId,
          id: { in: topProductSales.map((r) => r.productId).filter((id): id is string => id !== null) },
        },
        select: { id: true, name: true },
      })
    : [];

  return { business, invoicesRaw, purchaseRequestsRaw, fullProductCatalog, topProductSales, topProductNameRows };
}

const staticCache = new TtlStore<StaticBusinessContext>();
// Singleflight: concurrent cold-miss requests for the same businessId share one DB fetch.
const inflight = new Map<string, Promise<StaticBusinessContext | null>>();

// REL-N-10: cap how long a singleflight can block concurrent requests.
// Without a timeout a hung DB fetch holds all concurrent requests for the same
// business until the 40s LLM_TIMEOUT_MS gate fires a silent 504.
const SINGLEFLIGHT_TIMEOUT_MS = 15_000;

export async function loadStaticBusinessContext(businessId: string): Promise<StaticBusinessContext | null> {
  const cached = staticCache.get(businessId);
  if (cached) return cached;

  const pending = inflight.get(businessId);
  if (pending) return pending;

  // REG-T3-PERF-2: the singleflight timeout below clears the `inflight` map
  // so a follow-up request starts a new fetch instead of waiting on the
  // hung one. Prisma v6 has no native query cancellation (issue
  // prisma/prisma#15594), so the original Postgres query keeps running
  // until it completes; the connection pool size is the bound.
  const fetchPromise = fetchStaticBusinessContext(businessId)
    .then((result) => {
      inflight.delete(businessId);
      if (!result.business) return null;
      const nonNull = result as StaticBusinessContext;
      staticCache.set(businessId, nonNull);
      return nonNull;
    })
    .catch((err: unknown) => {
      inflight.delete(businessId);
      throw err;
    });

  const timeoutPromise = new Promise<StaticBusinessContext | null>((_, reject) =>
    setTimeout(() => {
      inflight.delete(businessId);
      reject(new Error(`loadStaticBusinessContext timed out after ${SINGLEFLIGHT_TIMEOUT_MS}ms`));
    }, SINGLEFLIGHT_TIMEOUT_MS),
  );

  const promise = Promise.race([fetchPromise, timeoutPromise]);
  inflight.set(businessId, promise);
  return promise;
}

export function invalidateBusinessContext(businessId: string): void {
  staticCache.delete(businessId);
}
