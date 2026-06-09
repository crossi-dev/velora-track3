import "server-only";
// ventas-core-tools.backend.ts — Backend port + Prisma adapter for VENTAS-CORE tools.
//
// Mirrors the hexagonal pattern: port (this file) → adapter (Prisma impl) → factory.
// The tool file (ventas-core-tools.ts) imports only from this module and never
// touches prisma directly — enabling test doubles without patching the module graph.
//
// Tenant isolation: every query is scoped by businessId. The backend carries
// businessId so individual tool methods don't need to receive it as an argument.

import { prisma } from "@/lib/prisma";

// ── Port interfaces ────────────────────────────────────────────────────────────

export interface SaleRow {
  id: string;
  date: Date;
  totalAmount: number;
  taxAmount: number;
  status: string;
  customerId: string | null;
  saleItems: SaleItemRow[];
  customer: { name: string; phone: string | null } | null;
}

export interface SaleItemRow {
  id: string;
  productId: string | null;
  quantity: number;
  unitPrice: number;
  product: { name: string } | null;
}

export interface ProductRow {
  id: string;
  name: string;
  price: number;
  stock: number;
}

export interface CustomerRow {
  id: string;
  name: string;
  phone: string | null;
}

export interface VentasCoreBackend {
  /** Tenant identifier — carried on the backend so tools receive a single dep. */
  businessId: string;
  /** Resolve a sale by exact ID. Returns null when not found or wrong tenant. */
  findSaleById(saleId: string): Promise<SaleRow | null>;
  /** Most-recent sale whose customer name contains the description fragment. */
  findSaleByDescription(description: string): Promise<SaleRow | null>;
  /** Product by name fragment (for presupuesto catalog hints). */
  findProductByName(name: string): Promise<ProductRow | null>;
  /** Atomic CAS stamp on paymentRequestSentAt — returns true if stamp claimed. */
  claimReceiptStamp(saleId: string): Promise<boolean>;
  /** Best-effort stamp rollback on WPP send failure. */
  releaseReceiptStamp(saleId: string): Promise<void>;
  /** Customer row for WPP outbound. */
  findCustomerById(customerId: string): Promise<CustomerRow | null>;
}

// ── Prisma query select ────────────────────────────────────────────────────────

const SALE_SELECT = {
  id: true,
  date: true,
  totalAmount: true,
  taxAmount: true,
  status: true,
  customerId: true,
  customer: { select: { name: true, phone: true } },
  saleItems: {
    select: {
      id: true,
      productId: true,
      quantity: true,
      unitPrice: true,
      product: { select: { name: true } },
    },
  },
} as const;

type RawSaleRow = Awaited<ReturnType<typeof prisma.sale.findFirst<{ select: typeof SALE_SELECT }>>>;

function toSaleRow(raw: NonNullable<RawSaleRow>): SaleRow {
  return {
    id: raw.id,
    date: raw.date,
    // Prisma v6 returns Decimal; call .toNumber() defensively.
    totalAmount: typeof raw.totalAmount === "number"
      ? raw.totalAmount
      : (raw.totalAmount as { toNumber(): number }).toNumber(),
    taxAmount: typeof raw.taxAmount === "number"
      ? raw.taxAmount
      : (raw.taxAmount as { toNumber(): number }).toNumber(),
    status: raw.status,
    customerId: raw.customerId,
    customer: raw.customer,
    saleItems: raw.saleItems.map((i) => ({
      id: i.id,
      productId: i.productId,
      quantity: i.quantity,
      unitPrice: typeof i.unitPrice === "number"
        ? i.unitPrice
        : (i.unitPrice as { toNumber(): number }).toNumber(),
      product: i.product,
    })),
  };
}

// ── Concrete Prisma adapter ────────────────────────────────────────────────────

export function createVentasCoreBackend(businessId: string): VentasCoreBackend {
  return {
    businessId,

    async findSaleById(saleId) {
      const row = await prisma.sale.findFirst({
        where: { id: saleId, businessId },
        select: SALE_SELECT,
      });
      return row ? toSaleRow(row) : null;
    },

    async findSaleByDescription(description) {
      const rows = await prisma.sale.findMany({
        where: {
          businessId,
          customer: { name: { contains: description, mode: "insensitive" } },
        },
        orderBy: { date: "desc" },
        take: 1,
        select: SALE_SELECT,
      });
      return rows[0] ? toSaleRow(rows[0]) : null;
    },

    async findProductByName(name) {
      const row = await prisma.product.findFirst({
        where: { businessId, name: { contains: name, mode: "insensitive" } },
        select: { id: true, name: true, price: true, quantity: true },
        orderBy: { name: "asc" },
      });
      if (!row) return null;
      return {
        id: row.id,
        name: row.name,
        price: typeof row.price === "number"
          ? row.price
          : (row.price as { toNumber(): number }).toNumber(),
        stock: row.quantity,
      };
    },

    async claimReceiptStamp(saleId) {
      const result = await prisma.sale.updateMany({
        where: { id: saleId, businessId, paymentRequestSentAt: null },
        data: { paymentRequestSentAt: new Date() },
      });
      return result.count > 0;
    },

    async releaseReceiptStamp(saleId) {
      await prisma.sale.updateMany({
        where: { id: saleId, businessId },
        data: { paymentRequestSentAt: null },
      }).catch(() => { /* best-effort rollback — ignore secondary failure */ });
    },

    async findCustomerById(customerId) {
      const row = await prisma.customer.findFirst({
        where: { id: customerId, businessId },
        select: { id: true, name: true, phone: true },
      });
      return row ?? null;
    },
  };
}

// ── Shared helper ──────────────────────────────────────────────────────────────

/** Resolves a sale by exact ID first, then by customer description fallback. */
export async function resolveSale(
  backend: VentasCoreBackend,
  saleId: string | undefined,
  customerDescription: string | undefined,
): Promise<SaleRow | null> {
  if (saleId?.trim()) return backend.findSaleById(saleId.trim());
  if (customerDescription?.trim()) return backend.findSaleByDescription(customerDescription.trim());
  return null;
}

