import "server-only";
// catalogo-precios-execute.ts — Execute body for catalogo.precios_por_tipo_cliente.
// Split from catalogo-precios-tipo-cliente-tool.ts to stay under the 300-line limit.

import { prisma } from "@/lib/prisma";
import {
  beginIdempotentMutation,
  completeIdempotentMutation,
  releaseIdempotentMutation,
} from "@/app/api/_lib/idempotency";
import { recordCriticalWriteEvent } from "@/infrastructure/shared/critical-write-audit";
import type { CatalogoPrecionTipoClienteBackend, PreciosTipoClienteInput } from "../catalogo-precios-tipo-cliente-tool";
import type { ToolResult } from "../_shared/create-tool";

// ── Helpers ───────────────────────────────────────────────────────────────────

const findProduct = (businessId: string, name: string) =>
  prisma.product.findFirst({
    where: { businessId, name: { contains: name.trim(), mode: "insensitive" } },
    select: { id: true, name: true, price: true },
  });

const findCustomer = (businessId: string, name: string) =>
  prisma.customer.findFirst({
    where: { businessId, name: { contains: name.trim(), mode: "insensitive" } },
    select: { id: true, name: true },
  });

// ── list_tiers ────────────────────────────────────────────────────────────────

export async function executeListTiers(businessId: string): Promise<ToolResult> {
  const tiers = await prisma.productPriceTier.findMany({
    where: { businessId },
    select: {
      id: true,
      label: true,
      description: true,
      entries: { select: { product: { select: { name: true } }, price: true } },
      _count: { select: { customers: true } },
    },
    orderBy: { label: "asc" },
  });
  return {
    tiers: tiers.map((t) => ({
      id: t.id,
      label: t.label,
      description: t.description ?? null,
      customerCount: t._count.customers,
      overrides: t.entries.map((e) => ({ productName: e.product.name, price: Number(e.price) })),
    })),
    total: tiers.length,
  };
}

// ── query_price ───────────────────────────────────────────────────────────────

export async function executeQueryPrice(
  businessId: string,
  customerName: string,
  productName: string,
): Promise<ToolResult> {
  const customer = await prisma.customer.findFirst({
    where: { businessId, name: { contains: customerName.trim(), mode: "insensitive" } },
    select: { id: true, name: true, priceTierId: true },
  });
  if (!customer) {
    return { error: { code: "CUSTOMER_NOT_FOUND", message: `No encontré un cliente llamado "${customerName}".` } };
  }

  const product = await findProduct(businessId, productName);
  if (!product) {
    return { error: { code: "PRODUCT_NOT_FOUND", message: `No encontré un producto llamado "${productName}".` } };
  }

  // C-1 fix: base price comes from the tenant-scoped findProduct select (price: true).
  // No standalone findUnique — that would be an unscoped query.
  const basePrice = Number(product.price ?? 0);

  if (!customer.priceTierId) {
    return { customerName: customer.name, productName: product.name, effectivePrice: basePrice, priceSource: "base", tierLabel: null };
  }

  const tierEntry = await prisma.productPriceTierEntry.findUnique({
    where: { tierId_productId: { tierId: customer.priceTierId, productId: product.id } },
    select: { price: true, tier: { select: { label: true } } },
  });

  if (!tierEntry) {
    return {
      customerName: customer.name,
      productName: product.name,
      effectivePrice: basePrice,
      priceSource: "base",
      tierLabel: null,
      note: "El tier del cliente no tiene override para este producto.",
    };
  }

  return {
    customerName: customer.name,
    productName: product.name,
    effectivePrice: Number(tierEntry.price),
    priceSource: "tier",
    tierLabel: tierEntry.tier.label,
  };
}

// ── upsert_tier ───────────────────────────────────────────────────────────────

export async function executeUpsertTier(
  b: CatalogoPrecionTipoClienteBackend,
  input: Extract<PreciosTipoClienteInput, { action: "upsert_tier" }>,
): Promise<ToolResult> {
  const { businessId, actorUserId, actorEmployeeId } = b;

  const idem = await beginIdempotentMutation({
    client: prisma,
    businessId,
    actionType: "catalogo.tier.upsert",
    idempotencyKey: input.idempotency_key,
    requestBody: { tierLabel: input.tierLabel },
  });
  // W-2: returns a plain ToolResult object, NOT idem.response (which is a NextResponse).
  // FunctionTool.execute() must return a plain object — returning NextResponse here
  // would corrupt the LLM payload. Intentional deviation from route-handler pattern.
  if (idem.kind === "replay") return { replayed: true, message: "Operación ya ejecutada (idempotencia)." };
  if (idem.kind !== "execute") return { error: { code: "IDEMPOTENCY_CONFLICT", message: "Conflicto de idempotencia. Reintentá." } };
  const { recordId } = idem;

  let tier: { id: string };
  try {
    // C-2 fix: tier upsert + all override entry upserts run inside a single
    // interactive transaction so a mid-loop failure cannot leave a partial commit
    // (tier committed, some overrides missing).
    tier = await prisma.$transaction(async (tx) => {
      const t = await tx.productPriceTier.upsert({
        where: { businessId_label: { businessId, label: input.tierLabel } },
        create: { businessId, label: input.tierLabel, description: input.description ?? null },
        update: { description: input.description ?? undefined },
        select: { id: true },
      });
      for (const ov of input.overrides ?? []) {
        // findProduct uses the outer `prisma` client (read-only lookup — safe outside tx).
        const prod = await findProduct(businessId, ov.productName);
        if (!prod) continue;
        await tx.productPriceTierEntry.upsert({
          where: { tierId_productId: { tierId: t.id, productId: prod.id } },
          create: { tierId: t.id, productId: prod.id, price: ov.price },
          update: { price: ov.price },
        });
      }
      return t;
    });
    await completeIdempotentMutation({
      client: prisma, recordId, responseStatus: 200,
      responseBody: { tierId: tier.id, label: input.tierLabel },
    });
  } catch (err) {
    await releaseIdempotentMutation({ client: prisma, recordId });
    throw err;
  }

  await recordCriticalWriteEvent({
    client: prisma, businessId, actorUserId, actorEmployeeId,
    routeScope: "catalogo/tiers",
    actionType: "catalogo.tier.upsert",
    resourceType: "product_price_tier",
    resourceId: tier.id,
    summary: `Tier "${input.tierLabel}" guardado con ${(input.overrides ?? []).length} overrides.`,
    payload: { label: input.tierLabel, overrideCount: (input.overrides ?? []).length },
    after: { tierId: tier.id, label: input.tierLabel },
  });

  return {
    tierId: tier.id,
    label: input.tierLabel,
    overridesApplied: (input.overrides ?? []).length,
    message: `Tier "${input.tierLabel}" guardado con ${(input.overrides ?? []).length} precios especiales.`,
  };
}

// ── assign_customer ───────────────────────────────────────────────────────────

export async function executeAssignCustomer(
  b: CatalogoPrecionTipoClienteBackend,
  input: Extract<PreciosTipoClienteInput, { action: "assign_customer" }>,
): Promise<ToolResult> {
  const { businessId, actorUserId, actorEmployeeId } = b;

  const customer = await findCustomer(businessId, input.customerName);
  if (!customer) {
    return { error: { code: "CUSTOMER_NOT_FOUND", message: `No encontré un cliente llamado "${input.customerName}".` } };
  }

  const tier = await prisma.productPriceTier.findFirst({
    where: { businessId, label: { equals: input.tierLabel, mode: "insensitive" } },
    select: { id: true, label: true },
  });
  if (!tier) {
    return {
      error: {
        code: "TIER_NOT_FOUND",
        message: `No existe el tier "${input.tierLabel}". Crealo primero con action='upsert_tier'.`,
      },
    };
  }

  const idem = await beginIdempotentMutation({
    client: prisma,
    businessId,
    actionType: "catalogo.tier.assign-customer",
    idempotencyKey: input.idempotency_key,
    requestBody: { customerId: customer.id, tierId: tier.id },
  });
  // W-2: same as upsert_tier above — returns plain ToolResult, NOT idem.response (NextResponse).
  // FunctionTool.execute() cannot return a NextResponse to the LLM runtime.
  if (idem.kind === "replay") return { replayed: true, message: "Operación ya ejecutada (idempotencia)." };
  if (idem.kind !== "execute") return { error: { code: "IDEMPOTENCY_CONFLICT", message: "Conflicto de idempotencia. Reintentá." } };
  const { recordId } = idem;

  try {
    // Defense-in-depth: scope by businessId (customer.id was resolved within this tenant).
    await prisma.customer.updateMany({ where: { id: customer.id, businessId }, data: { priceTierId: tier.id } });
    await completeIdempotentMutation({
      client: prisma, recordId, responseStatus: 200,
      responseBody: { customerId: customer.id, tierId: tier.id },
    });
  } catch (err) {
    await releaseIdempotentMutation({ client: prisma, recordId });
    throw err;
  }

  await recordCriticalWriteEvent({
    client: prisma, businessId, actorUserId, actorEmployeeId,
    routeScope: "catalogo/tiers/assign",
    actionType: "catalogo.tier.assign-customer",
    resourceType: "customer",
    resourceId: customer.id,
    summary: `Cliente "${customer.name}" asignado al tier "${tier.label}".`,
    payload: { customerId: customer.id, tierId: tier.id, tierLabel: tier.label },
    after: { priceTierId: tier.id },
  });

  return {
    customerId: customer.id,
    customerName: customer.name,
    tierId: tier.id,
    tierLabel: tier.label,
    message: `${customer.name} ahora tiene precios de tipo "${tier.label}".`,
  };
}
